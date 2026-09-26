import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"
import { authTables } from "@convex-dev/auth/server"

const role = v.union(
  v.literal("TENANT_OWNER"),
  v.literal("TENANT_ADMIN"),
  v.literal("SECURITY_ADMIN"),
  v.literal("DEPARTMENT_HEAD"),
  v.literal("GATE_GUARD"),
  v.literal("REPORT_VIEWER"),
  v.literal("STAFF"),
)
const credentialStatus = v.union(
  v.literal("issued"), v.literal("active"), v.literal("completed"),
  v.literal("expired"), v.literal("revoked"),
)
const subjectType = v.union(
  v.literal("visitor"), v.literal("contractor"), v.literal("supplier"),
)
const gateEventType = v.union(
  v.literal("check_in"), v.literal("check_out"), v.literal("revoke"),
)
const invitationStatus = v.union(
  v.literal("pending"), v.literal("accepted"), v.literal("revoked"), v.literal("expired"),
)
const visitorStatus = v.union(
  v.literal("expected"), v.literal("checked_in"), v.literal("checked_out"), v.literal("cancelled"),
)

export default defineSchema({
  ...authTables,

  tenantSettings: defineTable({ key:v.string(), value:v.string(), updatedAt:v.number() })
    .index("by_key",["key"]),

  branding: defineTable({ companyName:v.string(), logoStorageId:v.optional(v.id("_storage")), updatedAt:v.number() })
    .index("by_name",["companyName"]),

  tenantMetrics: defineTable({
    key:v.string(), staff:v.number(), visitors:v.number(), contractors:v.number(), suppliers:v.number(),
    credentials:v.number(), gateEvents:v.number(), unreadNotifications:v.number(), updatedAt:v.number(),
  }).index("by_key",["key"]),

  departments: defineTable({
    name:v.string(), code:v.string(), active:v.boolean(), createdAt:v.number(), updatedAt:v.number(),
  }).index("by_code",["code"]).index("by_active",["active"]),

  staffProfiles: defineTable({
    subject:v.string(), email:v.string(), name:v.string(), role, departmentId:v.optional(v.id("departments")),
    active:v.boolean(), createdAt:v.number(), updatedAt:v.number(),
  }).index("by_subject",["subject"]).index("by_email",["email"]).index("by_role",["role"])
    .index("by_department",["departmentId"]),

  invitations: defineTable({
    email:v.string(), name:v.string(), role, departmentId:v.optional(v.id("departments")), tokenHash:v.string(),
    status:invitationStatus, expiresAt:v.number(), invitedBy:v.string(), createdAt:v.number(), acceptedAt:v.optional(v.number()),
  }).index("by_email",["email"]).index("by_token_hash",["tokenHash"]).index("by_status",["status"]),

  visitors: defineTable({
    name:v.string(), email:v.optional(v.string()), phone:v.optional(v.string()), company:v.optional(v.string()),
    from:v.optional(v.string()), purpose:v.optional(v.string()), hostSubject:v.string(),
    departmentId:v.id("departments"), status:visitorStatus, passcodeAssignedAt:v.optional(v.number()),
    createdAt:v.number(), updatedAt:v.number(),
  }).index("by_department",["departmentId"]).index("by_host",["hostSubject"])
    .index("by_status",["status"]).index("by_created_at",["createdAt"]),

  contractors: defineTable({
    name:v.string(), company:v.string(), contact:v.optional(v.string()), active:v.boolean(), createdAt:v.number(), updatedAt:v.number(),
  }).index("by_active",["active"]),

  suppliers: defineTable({
    company:v.string(), contact:v.optional(v.string()), active:v.boolean(), createdAt:v.number(), updatedAt:v.number(),
  }).index("by_active",["active"]),

  accessCredentials: defineTable({
    codeHash:v.string(), codePrefix:v.string(), subjectType, subjectId:v.string(),
    visitorId:v.optional(v.id("visitors")), departmentId:v.optional(v.id("departments")),
    hostSubject:v.optional(v.string()), validFrom:v.number(), validUntil:v.number(), status:credentialStatus,
    issuedBy:v.string(), createdAt:v.number(), invalidatedAt:v.optional(v.number()),
  }).index("by_prefix",["codePrefix"]).index("by_status",["status"])
    .index("by_subject",["subjectType","subjectId"]).index("by_visitor",["visitorId"])
    .index("by_department",["departmentId"]),

  gateEvents: defineTable({
    credentialId:v.id("accessCredentials"), eventType:gateEventType, occurredAt:v.number(),
    operatorSubject:v.string(), note:v.optional(v.string()),
  }).index("by_credential",["credentialId"]).index("by_occurred",["occurredAt"]),

  notifications: defineTable({
    recipientSubject:v.string(), title:v.string(), message:v.string(), read:v.boolean(), createdAt:v.number(),
  }).index("by_recipient",["recipientSubject"]).index("by_recipient_read",["recipientSubject","read"]),

  auditEvents: defineTable({
    actorSubject:v.optional(v.string()), actorName:v.string(), action:v.string(), entityType:v.string(),
    entityId:v.optional(v.string()), summary:v.string(), departmentId:v.optional(v.id("departments")), createdAt:v.number(), metadata:v.optional(v.string()),
  }).index("by_created_at",["createdAt"]).index("by_actor",["actorSubject"]).index("by_entity",["entityType","entityId"])
    .index("by_department",["departmentId"]),
})