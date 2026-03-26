const dotenv = require("dotenv");
dotenv.config();

const DB_URL =
    process.env.DATABASE_URL ||
    "postgres://postgres:postgres@localhost:5432/medusa";

module.exports = {
    projectConfig: {
        database_url: DB_URL,
        database_type: "postgres",
        store_cors: process.env.STORE_CORS || "*",
        admin_cors: process.env.ADMIN_CORS || "*",
        database_extra:
            process.env.NODE_ENV === "production"
                ? { ssl: { rejectUnauthorized: false } }
                : {},
    },
    plugins: [
        {
            resolve: "@medusajs/admin",
            options: {
                autoRebuild: false,
                serve: true,
                path: "/app",
                develop: {
                    open: false,
                },
            },
        },
        `medusa-fulfillment-manual`,
        `medusa-payment-manual`,
        {
            resolve: `@medusajs/cache-inmemory`,
            options: {
                ttl: 30,
            },
        },
        {
            resolve: `@medusajs/event-bus-local`,
        },
    ],
};
