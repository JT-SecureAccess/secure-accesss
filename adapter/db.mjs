import pg from "pg"
import crypto from "node:crypto"

const {Pool}=pg
let pool

function getPool(){
  if(!pool){
    const url=process.env.ADAPTER_DATABASE_URL
    if(!url)throw new Error("ADAPTER_DATABASE_URL is required")
    pool=new Pool({connectionString:url,ssl:process.env.ADAPTER_DATABASE_SSL==="false"?false:{rejectUnauthorized:false},max:5})
  }
  return pool
}

function json(value){return value==null?null:JSON.stringify(value)}
function key(){const s=process.env.TENANT_ADAPTER_SECRET;if(!s)throw new Error("TENANT_ADAPTER_SECRET is required");return crypto.createHash("sha256").update(s).digest()}
function protect(value){if(value==null)return null;const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv("aes-256-gcm",key(),iv);const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value),"utf8"),cipher.final()]);return JSON.stringify({v:1,iv:iv.toString("base64url"),tag:cipher.getAuthTag().toString("base64url"),data:ciphertext.toString("base64url")})}
export function unprotect(value){if(!value)return null;const x=typeof value==="string"?JSON.parse(value):value;if(x.v!==1)throw new Error("Unsupported protected job payload");const decipher=crypto.createDecipheriv("aes-256-gcm",key(),Buffer.from(x.iv,"base64url"));decipher.setAuthTag(Buffer.from(x.tag,"base64url"));return JSON.parse(Buffer.concat([decipher.update(Buffer.from(x.data,"base64url")),decipher.final()]).toString("utf8"))}

export async function migrateStore(){
  await getPool().query(`
    create table if not exists adapter_jobs (
      job_id text primary key,
      idempotency_key text not null unique,
      tenant_id text not null,
      tenant_slug text not null,
      provider text not null,
      status text not null,
      step text,
      attempt integer not null default 0,
      input jsonb,
      resource jsonb,
      result jsonb,
      errors jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      completed_at timestamptz
    );
    create index if not exists adapter_jobs_tenant_status on adapter_jobs(tenant_id,status);
  `)
}

export async function getJobById(jobId){
  const {rows}=await getPool().query("select * from adapter_jobs where job_id=$1",[jobId])
  return rows[0]??null
}

export async function getJobByIdempotency(key){
  const {rows}=await getPool().query("select * from adapter_jobs where idempotency_key=$1",[key])
  return rows[0]??null
}

export async function createJob(input,jobId){
  const {rows}=await getPool().query(
    `insert into adapter_jobs
      (job_id,idempotency_key,tenant_id,tenant_slug,provider,status,step,attempt,input,created_at,updated_at)
     values($1,$2,$3,$4,$5,'QUEUED','QUEUED',0,$6,now(),now())
     on conflict(idempotency_key) do nothing
     returning *`,
    [jobId,input.idempotencyKey,input.tenantId,input.tenantSlug,input.provider,protect(input)]
  )
  if(rows[0])return rows[0]
  return await getJobByIdempotency(input.idempotencyKey)
}

export async function claimJob(jobId){
  const {rows}=await getPool().query(
    `update adapter_jobs
     set status='RUNNING',step='RUNNING',attempt=attempt+1,updated_at=now()
     where job_id=$1 and status in ('QUEUED','RETRY')
     returning *`,[jobId])
  return rows[0]??null
}

export async function updateJob(jobId,patch){
  const fields=[],values=[],allowed={status:"status",step:"step",resource:"resource",result:"result",errors:"errors"}
  for(const [k,v] of Object.entries(patch??{})){
    if(allowed[k]){fields.push(allowed[k]+"=$"+(values.length+1));values.push(typeof v==="object"?json(v):v)}
  }
  if(!fields.length)return getJobById(jobId)
  fields.push("updated_at=now()")
  values.push(jobId)
  const {rows}=await getPool().query(`update adapter_jobs set ${fields.join(",")} where job_id=$${values.length} returning *`,values)
  return rows[0]??null
}

export async function closeStore(){
  if(pool){await pool.end();pool=null}
}
