import { defineConfig, loadEnv } from "@medusajs/framework/utils";

loadEnv(process.env.NODE_ENV || "production", process.cwd());

const r2PublicUrl = process.env.R2_PUBLIC_URL?.replace(/\/$/, "");

export default defineConfig({
    projectConfig: {
        databaseUrl: process.env.DATABASE_URL,
        databaseDriverOptions: {
            ssl: process.env.DATABASE_SSL === "true"
                ? { rejectUnauthorized: false }
                : false,
        },
        http: {
            storeCors: process.env.STORE_CORS || "*",
            adminCors: process.env.ADMIN_CORS || "*",
            authCors: process.env.AUTH_CORS || "*",
            jwtSecret: process.env.JWT_SECRET || "supersecret-jwt-token",
            cookieSecret: process.env.COOKIE_SECRET || "supersecret-cookie-token",
        },
        redisUrl: process.env.REDIS_URL,
    },
    modules: [
        // File storage: use R2 (S3-compatible) if credentials are provided, else local
        ...(process.env.R2_ACCESS_KEY_ID ? [{
            resolve: "@medusajs/file",
            options: {
                providers: [
                    {
                        resolve: "@medusajs/file-s3",
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
        }] : [
            {
                resolve: "@medusajs/file",
                options: {
                    providers: [
                        {
                            resolve: "@medusajs/file-local",
                            id: "local",
                            options: {
                                upload_dir: "static",
                                backend_url: process.env.MEDUSA_BACKEND_URL 
                                    ? `${process.env.MEDUSA_BACKEND_URL}/static`
                                    : "http://localhost:9000/static",
                            },
                        },
                    ],
                },
            },
        ]),
    ],
    admin: {
        disable: process.env.DISABLE_ADMIN === "true",
        path: "/app",
        backendUrl: process.env.MEDUSA_BACKEND_URL || "/",
    },
});
