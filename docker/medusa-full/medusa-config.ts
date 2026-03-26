import { defineConfig, loadEnv } from "@medusajs/framework/utils";

loadEnv(process.env.NODE_ENV || "production", process.cwd());

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
    ],
    admin: {
        disable: process.env.DISABLE_ADMIN === "true",
        path: "/app",
        backendUrl: process.env.MEDUSA_BACKEND_URL || "/",
    },
});