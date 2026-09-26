import pg from "pg"

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
    [jobId,input.idempotencyKey,input.tenantId,input.tenantSlug,input.provider,json(input)]
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
