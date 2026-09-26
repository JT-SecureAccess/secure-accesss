import { v } from "convex/values"
import { query, mutation, internalMutation } from "./_generated/server"
import { internal } from "./_generated/api"

const subjectType=v.union(v.literal("visitor"),v.literal("contractor"),v.literal("supplier"))
const eventType=v.union(v.literal("check_in"),v.literal("check_out"),v.literal("revoke"))
const fail=v.object({ok:v.literal(false),message:v.string()})

async function actor(ctx:any,roles:string[]){
  const identity=await ctx.auth.getUserIdentity()
  if(!identity)return null
  const p=(await ctx.db.query("staffProfiles").withIndex("by_subject",q=>q.eq("subject",identity.subject)).take(1))[0]
  return p&&p.active&&roles.includes(p.role)?p:null
}
async function department(ctx:any,id:any){return id?await ctx.db.get(id):null}
function bounded(v:string|undefined,max:number){return v?.trim().slice(0,max)||undefined}

export const createVisitor=mutation({
  args:{name:v.string(),email:v.optional(v.string()),phone:v.optional(v.string()),company:v.optional(v.string()),from:v.optional(v.string()),purpose:v.optional(v.string()),departmentId:v.id("departments")},
  returns:v.union(v.id("visitors"),fail),
  handler:async(ctx,args)=>{
    const a=await actor(ctx,["TENANT_OWNER","TENANT_ADMIN","DEPARTMENT_HEAD"])
    if(!a)return {ok:false as const,message:"Only the host/tenant manager can register an expected visitor."}
    const d=await department(ctx,args.departmentId)
    if(!d||!d.active)return {ok:false as const,message:"Department is not active."}
    if(a.role==="DEPARTMENT_HEAD"&&a.departmentId!==args.departmentId)return {ok:false as const,message:"You can only register visitors for your department."}
    const name=args.name.trim().slice(0,160),purpose=bounded(args.purpose,500)
    if(!name||!purpose)return {ok:false as const,message:"Visitor name and purpose are required."}
    const now=Date.now()
    const id=await ctx.db.insert("visitors",{
      name,email:bounded(args.email,254)?.toLowerCase(),phone:bounded(args.phone,40),company:bounded(args.company,160),
      from:bounded(args.from,160),purpose,hostSubject:a.subject,departmentId:args.departmentId,status:"expected",createdAt:now,updatedAt:now
    })
    await ctx.db.insert("auditEvents",{actorSubject:a.subject,actorName:a.name,action:"visitor_created",entityType:"visitor",entityId:id.toString(),summary:"Expected visitor created.",departmentId:args.departmentId,createdAt:now})
    await ctx.scheduler.runAfter(0,internal.tenant.recomputeMetrics,{})
    return id
  }
})

export const createContractor=mutation({
  args:{name:v.string(),company:v.string(),contact:v.optional(v.string())},
  returns:v.union(v.id("contractors"),fail),
  handler:async(ctx,args)=>{
    const a=await actor(ctx,["TENANT_OWNER","TENANT_ADMIN","SECURITY_ADMIN"])
    if(!a)return {ok:false as const,message:"Tenant permission denied."}
    const name=args.name.trim().slice(0,160),company=args.company.trim().slice(0,160)
    if(!name||!company)return {ok:false as const,message:"Contractor name and company are required."}
    const id=await ctx.db.insert("contractors",{name,company,contact:bounded(args.contact,160),active:true,createdAt:Date.now(),updatedAt:Date.now()})
    await ctx.scheduler.runAfter(0,internal.tenant.recomputeMetrics,{})
    return id
  }
})

export const createSupplier=mutation({
  args:{company:v.string(),contact:v.optional(v.string())},
  returns:v.union(v.id("suppliers"),fail),
  handler:async(ctx,args)=>{
    const a=await actor(ctx,["TENANT_OWNER","TENANT_ADMIN","SECURITY_ADMIN"])
    if(!a)return {ok:false as const,message:"Tenant permission denied."}
    const company=args.company.trim().slice(0,160)
    if(!company)return {ok:false as const,message:"Supplier company is required."}
    const id=await ctx.db.insert("suppliers",{company,contact:bounded(args.contact,160),active:true,createdAt:Date.now(),updatedAt:Date.now()})
    await ctx.scheduler.runAfter(0,internal.tenant.recomputeMetrics,{})
    return id
  }
})

export const issueCredential=mutation({
  args:{codeHash:v.string(),codePrefix:v.string(),subjectType,subjectId:v.string(),visitorId:v.optional(v.id("visitors")),validFrom:v.number(),validUntil:v.number()},
  returns:v.union(v.id("accessCredentials"),fail),
  handler:async(ctx,args)=>{
    const a=await actor(ctx,["TENANT_OWNER","TENANT_ADMIN","SECURITY_ADMIN","DEPARTMENT_HEAD"])
    if(!a)return {ok:false as const,message:"Only an authorized host or security manager can issue a credential."}
    if(!args.codeHash.trim()||!args.subjectId.trim()||args.validUntil<=args.validFrom)return {ok:false as const,message:"Credential data or validity window is invalid."}
    let departmentId:any=undefined,hostSubject:any=undefined
    if(args.subjectType==="visitor"){
      if(!args.visitorId)return {ok:false as const,message:"Visitor credential must reference its visitor record."}
      const visitor=await ctx.db.get(args.visitorId)
      if(!visitor||visitor._id.toString()!==args.subjectId)return {ok:false as const,message:"Visitor record does not match the credential."}
      departmentId=visitor.departmentId;hostSubject=visitor.hostSubject
      if(!departmentId||!hostSubject)return {ok:false as const,message:"Visitor ownership is incomplete."}
      if(a.role==="DEPARTMENT_HEAD"&&(a.departmentId!==departmentId||a.subject!==hostSubject))return {ok:false as const,message:"You can only assign a passcode to your own expected visitor."}
      if(visitor.status!=="expected")return {ok:false as const,message:"This visitor is not awaiting a passcode."}
      await ctx.db.patch(visitor._id,{passcodeAssignedAt:Date.now(),updatedAt:Date.now()})
    }else if(a.role==="DEPARTMENT_HEAD"){
      return {ok:false as const,message:"Department heads can only issue visitor credentials."}
    }
    const id=await ctx.db.insert("accessCredentials",{codeHash:args.codeHash.trim(),codePrefix:args.codePrefix.trim().slice(0,24),subjectType:args.subjectType,subjectId:args.subjectId.trim(),visitorId:args.visitorId,departmentId,hostSubject,validFrom:args.validFrom,validUntil:args.validUntil,status:"issued",issuedBy:a.subject,createdAt:Date.now()})
    await ctx.db.insert("auditEvents",{actorSubject:a.subject,actorName:a.name,action:"credential_issued",entityType:"accessCredential",entityId:id.toString(),summary:"Access credential issued.",departmentId,createdAt:Date.now()})
    await ctx.scheduler.runAfter(0,internal.tenant.recomputeMetrics,{})
    return id
  }
})

export const recordGateEvent=mutation({
  args:{credentialId:v.id("accessCredentials"),eventType,note:v.optional(v.string())},
  returns:v.union(v.id("gateEvents"),fail),
  handler:async(ctx,args)=>{
    const a=await actor(ctx,["TENANT_OWNER","TENANT_ADMIN","SECURITY_ADMIN","GATE_GUARD"])
    if(!a)return {ok:false as const,message:"Gate access is restricted to authorized security personnel."}
    const c=await ctx.db.get(args.credentialId)
    if(!c)return {ok:false as const,message:"Credential not found."}
    const now=Date.now()
    if(c.status==="revoked")return {ok:false as const,message:"Credential is revoked."}
    if(now<c.validFrom||now>c.validUntil){
      if(c.status!=="completed")await ctx.db.patch(c._id,{status:"expired"})
      return {ok:false as const,message:"Credential is outside its validity window."}
    }
    if(args.eventType==="check_in"&&c.status!=="issued")return {ok:false as const,message:"This credential cannot be checked in in its current state."}
    if(args.eventType==="check_out"&&c.status!=="active")return {ok:false as const,message:"This credential is not currently checked in."}
    if(args.eventType==="revoke"&&c.status==="completed")return {ok:false as const,message:"A completed credential cannot be revoked."}
    const status=args.eventType==="check_in"?"active":args.eventType==="check_out"?"completed":"revoked"
    await ctx.db.patch(c._id,{status,...(args.eventType==="revoke"?{invalidatedAt:now}:{})})
    if(c.visitorId){
      const visitor=await ctx.db.get(c.visitorId)
      if(visitor){
        const visitorStatus=args.eventType==="check_in"?"checked_in":args.eventType==="check_out"?"checked_out":"cancelled"
        await ctx.db.patch(visitor._id,{status:visitorStatus,updatedAt:now})
        if(args.eventType==="check_in"&&visitor.hostSubject){
          await ctx.db.insert("notifications",{recipientSubject:visitor.hostSubject,title:"Visitor checked in",message:visitor.name+" has arrived and passed gate verification.",read:false,createdAt:now})
        }
      }
    }
    const id=await ctx.db.insert("gateEvents",{credentialId:c._id,eventType:args.eventType,occurredAt:now,operatorSubject:a.subject,note:bounded(args.note,500)})
    await ctx.db.insert("auditEvents",{actorSubject:a.subject,actorName:a.name,action:"gate_"+args.eventType,entityType:"accessCredential",entityId:c._id.toString(),summary:"Gate event recorded.",departmentId:c.departmentId,createdAt:now})
    await ctx.scheduler.runAfter(0,internal.tenant.recomputeMetrics,{})
    return id
  }
})

export const listRecentEvents=query({
  args:{limit:v.optional(v.number())},
  returns:v.union(v.array(v.object({_id:v.id("gateEvents"),_creationTime:v.number(),credentialId:v.id("accessCredentials"),eventType,occurredAt:v.number(),operatorSubject:v.string(),note:v.optional(v.string()),visitorName:v.optional(v.string()),departmentId:v.optional(v.id("departments"))})),fail),
  handler:async(ctx,args)=>{
    const a=await actor(ctx,["TENANT_OWNER","TENANT_ADMIN","SECURITY_ADMIN","DEPARTMENT_HEAD","GATE_GUARD"])
    if(!a)return {ok:false as const,message:"Tenant permission denied."}
    const limit=Math.min(Math.max(args.limit??50,1),100)
    const rows=await ctx.db.query("gateEvents").withIndex("by_occurred").order("desc").take(Math.min(limit*3,300))
    const startOfDay=new Date();startOfDay.setHours(0,0,0,0);const cutoff=startOfDay.getTime()
    const filtered:any[]=[]
    for(const e of rows){
      if(a.role==="GATE_GUARD"&&e.occurredAt<cutoff)continue
      const c=await ctx.db.get(e.credentialId);if(!c)continue
      if(a.role==="DEPARTMENT_HEAD"&&c.departmentId!==a.departmentId)continue
      const v=c.visitorId?await ctx.db.get(c.visitorId):null
      filtered.push({...e,visitorName:v?.name,departmentId:c.departmentId})
      if(filtered.length>=limit)break
    }
    return filtered
  }
})

export const listAudit=query({
  args:{limit:v.optional(v.number())},
  returns:v.union(v.array(v.object({_id:v.id("auditEvents"),_creationTime:v.number(),actorSubject:v.optional(v.string()),actorName:v.string(),action:v.string(),entityType:v.string(),entityId:v.optional(v.string()),summary:v.string(),departmentId:v.optional(v.id("departments")),createdAt:v.number(),metadata:v.optional(v.string())})),fail),
  handler:async(ctx,args)=>{
    const a=await actor(ctx,["TENANT_OWNER","TENANT_ADMIN","SECURITY_ADMIN","DEPARTMENT_HEAD"])
    if(!a)return {ok:false as const,message:"Tenant permission denied."}
    const rows=await ctx.db.query("auditEvents").withIndex("by_created_at").order("desc").take(Math.min(Math.max(args.limit??100,1),200))
    if(a.role!=="DEPARTMENT_HEAD")return rows
    return rows.filter(x=>x.departmentId===a.departmentId).slice(0,Math.min(Math.max(args.limit??100,1),200))
  }
})

export const listNotifications=query({
  args:{limit:v.optional(v.number())},
  returns:v.union(v.array(v.object({_id:v.id("notifications"),_creationTime:v.number(),recipientSubject:v.string(),title:v.string(),message:v.string(),read:v.boolean(),createdAt:v.number()})),fail),
  handler:async(ctx,args)=>{
    const identity=await ctx.auth.getUserIdentity();if(!identity)return {ok:false as const,message:"Authentication required."}
    return await ctx.db.query("notifications").withIndex("by_recipient",q=>q.eq("recipientSubject",identity.subject)).order("desc").take(Math.min(Math.max(args.limit??50,1),100))
  }
})

export const markNotificationRead=mutation({
  args:{notificationId:v.id("notifications")},returns:v.union(v.null(),fail),
  handler:async(ctx,args)=>{
    const identity=await ctx.auth.getUserIdentity();if(!identity)return {ok:false as const,message:"Authentication required."}
    const n=await ctx.db.get(args.notificationId);if(n&&n.recipientSubject===identity.subject&&!n.read)await ctx.db.patch(n._id,{read:true})
    return null
  }
})

export const updateBranding=mutation({
  args:{companyName:v.string(),logoStorageId:v.optional(v.id("_storage"))},returns:v.union(v.null(),fail),
  handler:async(ctx,args)=>{
    const a=await actor(ctx,["TENANT_OWNER","TENANT_ADMIN"]);if(!a)return {ok:false as const,message:"Tenant permission denied."}
    const companyName=args.companyName.trim().slice(0,160);if(!companyName)return {ok:false as const,message:"Company name is required."}
    const rows=await ctx.db.query("branding").withIndex("by_name").take(1)
    const data={companyName,logoStorageId:args.logoStorageId,updatedAt:Date.now()}
    if(rows[0])await ctx.db.patch(rows[0]._id,data);else await ctx.db.insert("branding",data)
    await ctx.db.insert("auditEvents",{actorSubject:a.subject,actorName:a.name,action:"branding_updated",entityType:"branding",summary:"Tenant branding updated.",createdAt:Date.now()})
    return null
  }
})

export const recomputeMetrics=internalMutation({
  args:{},returns:v.null(),
  handler:async(ctx)=>{
    const [s,vv,c,sp,cr,e]=await Promise.all([
      ctx.db.query("staffProfiles").take(5000),ctx.db.query("visitors").take(5000),ctx.db.query("contractors").take(5000),
      ctx.db.query("suppliers").take(5000),ctx.db.query("accessCredentials").take(5000),ctx.db.query("gateEvents").take(5000)
    ])
    const old=(await ctx.db.query("tenantMetrics").withIndex("by_key",q=>q.eq("key","global")).take(1))[0]
    const data={key:"global",staff:s.length,visitors:vv.length,contractors:c.length,suppliers:sp.length,credentials:cr.length,gateEvents:e.length,unreadNotifications:old?.unreadNotifications??0,updatedAt:Date.now()}
    if(old)await ctx.db.patch(old._id,data);else await ctx.db.insert("tenantMetrics",data)
    return null
  }
})
