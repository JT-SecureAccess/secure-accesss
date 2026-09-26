export default {
  providers: [
    {
      domain: process.env.TENANT_AUTH_ISSUER ?? "",
      applicationID: process.env.TENANT_AUTH_APPLICATION_ID ?? "convex",
    },
  ],
}
