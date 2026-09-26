import { v } from "convex/values"
import { query, mutation, internalMutation } from "./_generated/server"

const role=v.union(
  v.literal("TENANT_OWNER"),v.literal("TENANT_ADMIN"),v.literal("SECURITY_ADMIN"),
  v.literal("DEPARTMENT_HEAD"),v.literal("GATE_GUARD"),v.literal("REPORT_VIEWER"),v.literal("STAFF")
)
const profileShape=v.object({_id:v.id("staffProfiles"),_creationTime:v.number(),subject:v.string(),email:v.string(),name:v.string(),role,departmentId:v.optional(v.id("departments")),active:v.boolean(),createdAt:v.number(),updatedAt:v.number()})
const denied=(message:string)=>({ok:false as const,message})

async function identity(ctx:any){return await ctx.auth.getUserIdentity()}
async function profile(ctx:any,allowed:string[]){
  const id=await identity(ctx);if(!id)return null
  const p=(await ctx.db.query("staffProfiles").withIndex("by_subject",q=>q.eq("subject",id.subject)).take(1))[0]
  return p&&p.active&&allowed.includes(p.role)?p:null
}

export const bootstrap=internalMutation({
  args:{companyName:v.string(),ownerSubject:v.string(),ownerName:v.string(),ownerEmail:v.string()},
  returns:v.object({ok:v.literal(true)}),
  handler:async(ctx,args)=>{
    const exists=await ctx.db.query("tenantSettings").withIndex("by_key",q=>q.eq("key","initialized")).take(1)
    if(exists[0])return {ok:true as const}
    const now=Date.now(),name=args.companyName.trim().slice(0,160)
    await ctx.db.insert("tenantSettings",{key:"initialized",value:"true",updatedAt:now})
    await ctx.db.insert("tenantSettings",{key:"tenant_name",value:name,updatedAt:now})
    await ctx.db.insert("branding",{companyName:name,updatedAt:now})
    await ctx.db.insert("tenantMetrics",{key:"global",staff:1,visitors:0,contractors:0,suppliers:0,credentials:0,gateEvents:0,unreadNotifications:0,updatedAt:now})
    await ctx.db.insert("staffProfiles",{subject:args.ownerSubject,email:args.ownerEmail.trim().toLowerCase(),name:args.ownerName.trim().slice(0,120),role:"TENANT_OWNER",active:true,createdAt:now,updatedAt:now})
    return {ok:true as const}
  }
})

export const me=query({args:{},returns:v.union(v.null(),profileShape),handler:async(ctx)=>{
  const id=await identity(ctx);if(!id)return null
  return (await ctx.db.query("staffProfiles").withIndex("by_subject",q=>q.eq("subject",id.subject)).take(1))[0]??null
}})

export const bootstrapCurrentUser=mutation({
  args:{name:v.string()},
  returns:v.union(v.object({ok:v.literal(true),profile:profileShape}),v.object({ok:v.literal(false),message:v.string()})),
  handler:async(ctx,args)=>{
    const id=await identity(ctx);if(!id)return denied("Authentication required.")
    const subject=id.subject,email=(id.email??"").trim().toLowerCase();if(!email)return denied("Authenticated identity has no email.")
    const existing=(await ctx.db.query("staffProfiles").withIndex("by_subject",q=>q.eq("subject",subject)).take(1))[0]
    if(existing)return {ok:true as const,profile:existing}
    const byEmail=(await ctx.db.query("staffProfiles").withIndex("by_email",q=>q.eq("email",email)).take(1))[0]
    if(byEmail&&byEmail.active&&byEmail.subject!==subject)return denied("This tenant profile is already bound to another identity.")
    const invite=(await ctx.db.query("invitations").withIndex("by_email",q=>q.eq("email",email)).take(20)).find(i=>i.status==="pending"&&i.expiresAt>Date.now())
    if(!invite)return denied("No active tenant invitation was found.")
    const now=Date.now()
    const pid=await ctx.db.insert("staffProfiles",{subject,email,name:args.name.trim().slice(0,120)||invite.name,role:invite.role,departmentId:invite.departmentId,active:true,createdAt:now,updatedAt:now})
    await ctx.db.patch(invite._id,{status:"accepted",acceptedAt:now})
    return {ok:true as const,profile:(await ctx.db.get(pid))!}
  }
})

export const overview=query({
  args:{},returns:v.union(
    v.object({ok:v.literal(true),staff:v.number(),visitors:v.number(),contractors:v.number(),suppliers:v.number(),credentials:v.number(),events:v.number(),unreadNotifications:v.number()}),
    v.object({ok:v.literal(false),message:v.string()})
  ),
  handler:async(ctx)=>{
    const a=await profile(ctx,["TENANT_OWNER","TENANT_ADMIN","SECURITY_ADMIN","DEPARTMENT_HEAD","GATE_GUARD","REPORT_VIEWER","STAFF"])
    if(!a)return denied("Tenant permission denied.")
    const m=(await ctx.db.query("tenantMetrics").withIndex("by_key",q=>q.eq("key","global")).take(1))[0]
    if(a.role==="DEPARTMENT_HEAD"||a.role==="GATE_GUARD"||a.role==="STAFF")
      return {ok:true as const,staff:m?.staff??0,visitors:m?.visitors??0,contractors:0,suppliers:0,credentials:0,events:0,unreadNotifications:m?.unreadNotifications??0}
    return {ok:true as const,staff:m?.staff??0,visitors:m?.visitors??0,contractors:m?.contractors??0,suppliers:m?.suppliers??0,credentials:m?.credentials??0,events:m?.gateEvents??0,unreadNotifications:m?.unreadNotifications??0}
  }
})

export const listStaff=query({
  args:{limit:v.optional(v.number())},
  returns:v.union(v.array(profileShape),v.object({ok:v.literal(false),message:v.string()})),
  handler:async(ctx,args)=>{
    const a=await profile(ctx,["TENANT_OWNER","TENANT_ADMIN"])
    if(!a)return denied("Only account management can view staff administration.")
    return await ctx.db.query("staffProfiles").order("desc").take(Math.min(Math.max(args.limit??50,1),100))
  }
})

export const listDepartments=query({
  args:{},returns:v.union(v.array(v.object({_id:v.id("departments"),_creationTime:v.number(),name:v.string(),code:v.string(),active:v.boolean(),createdAt:v.number(),updatedAt:v.number()})),v.object({ok:v.literal(false),message:v.string()})),
  handler:async(ctx)=>{
    if(!await profile(ctx,["TENANT_OWNER","TENANT_ADMIN","SECURITY_ADMIN","DEPARTMENT_HEAD","GATE_GUARD","REPORT_VIEWER","STAFF"]))return denied("Tenant permission denied.")
    return await ctx.db.query("departments").withIndex("by_active",q=>q.eq("active",true)).take(500)
  }
})

export const createDepartment=mutation({
  args:{name:v.string(),code:v.string()},
  returns:v.union(v.id("departments"),v.object({ok:v.literal(false),message:v.string()})),
  handler:async(ctx,args)=>{
    const a=await profile(ctx,["TENANT_OWNER","TENANT_ADMIN"])
    if(!a)return denied("Only account management can configure departments.")
    const name=args.name.trim().slice(0,120),code=args.code.trim().toUpperCase().slice(0,30)
    if(!name||!code)return denied("Department name and code are required.")
    const existing=await ctx.db.query("departments").withIndex("by_code",q=>q.eq("code",code)).take(1)
    if(existing[0])return denied("Department code already exists.")
    const id=await ctx.db.insert("departments",{name,code,active:true,createdAt:Date.now(),updatedAt:Date.now()})
    return id
  }
})

export const inviteStaff=mutation({
  args:{email:v.string(),name:v.string(),role,departmentId:v.optional(v.id("departments")),tokenHash:v.string(),expiresAt:v.number()},
  returns:v.union(v.id("invitations"),v.object({ok:v.literal(false),message:v.string()})),
  handler:async(ctx,args)=>{
    const a=await profile(ctx,["TENANT_OWNER","TENANT_ADMIN"])
    if(!a)return denied("Only account management can invite staff.")
    const allowedRoles=["TENANT_ADMIN","SECURITY_ADMIN","DEPARTMENT_HEAD","GATE_GUARD","STAFF","REPORT_VIEWER"]
    if(!allowedRoles.includes(args.role))return denied("This role cannot be assigned through staff invitation.")
    if(args.role==="DEPARTMENT_HEAD"||args.role==="GATE_GUARD"||args.role==="STAFF"){
      if(!args.departmentId)return denied("Department is required for this staff role.")
      const d=await ctx.db.get(args.departmentId);if(!d||!d.active)return denied("Department is not active.")
    }
    const email=args.email.trim().toLowerCase(),name=args.name.trim().slice(0,120)
    if(!email.includes("@")||!name)return denied("Valid staff email and name are required.")
    if(args.expiresAt<=Date.now())return denied("Invitation expiry must be in the future.")
    return await ctx.db.insert("invitations",{email,name,role,departmentId:args.departmentId,tokenHash:args.tokenHash,status:"pending",expiresAt:args.expiresAt,invitedBy:a.subject,createdAt:Date.now()})
  }
})
