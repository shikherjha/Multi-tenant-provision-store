import { loadEnv, defineConfig } from '@medusajs/framework/utils'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

const r2PublicUrl = process.env.R2_PUBLIC_URL?.replace(/\/$/, "")

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET || "supersecret",
      cookieSecret: process.env.COOKIE_SECRET || "supersecret",
    }
  },
  modules: [
    // File storage: use R2 (S3-compatible) if credentials are provided, else local
    ...(process.env.R2_ACCESS_KEY_ID ? [{
      resolve: "@medusajs/medusa/file",
      options: {
        providers: [
          {
            resolve: "@medusajs/medusa/file-s3",
            id: "r2",
            options: {
              file_url: r2PublicUrl,
              access_key_id: process.env.R2_ACCESS_KEY_ID,
              secret_access_key: process.env.R2_SECRET_ACCESS_KEY,
              endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
              bucket: process.env.R2_BUCKET || "store-platform-media",
              region: "auto",
              additional_data: {
                prefix: process.env.STORE_NAME || "default",
              },
            },
          },
        ],
      },
    }] : []),
  ],
})
