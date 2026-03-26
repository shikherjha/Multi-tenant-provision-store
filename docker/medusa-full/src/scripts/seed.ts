import {
    createApiKeysWorkflow,
    createProductCategoriesWorkflow,
    createProductsWorkflow,
    createRegionsWorkflow,
    createSalesChannelsWorkflow,
    createShippingOptionsWorkflow,
    createShippingProfilesWorkflow,
    createStockLocationsWorkflow,
    linkSalesChannelsToApiKeyWorkflow,
    linkSalesChannelsToStockLocationWorkflow,
    updateStoresWorkflow,
} from "@medusajs/medusa/core-flows";
import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";

export default async function seedDemoData({ container }: ExecArgs) {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
    const remoteLink = container.resolve(ContainerRegistrationKeys.REMOTE_LINK);
    const query = container.resolve(ContainerRegistrationKeys.QUERY);
    const fulfillmentModuleService = container.resolve(Modules.FULFILLMENT);
    const salesChannelModuleService = container.resolve(Modules.SALES_CHANNEL);
    const storeModuleService = container.resolve(Modules.STORE);

    logger.info("Seeding store data...");

    const countries = ["us", "gb", "de", "dk", "se", "fr", "es", "it"];

    // Update store
    const [store] = await storeModuleService.listStores();
    let defaultSalesChannel = await salesChannelModuleService.listSalesChannels({
        name: "Default Sales Channel",
    });

    if (!defaultSalesChannel.length) {
        const { result: salesChannelResult } =
            await createSalesChannelsWorkflow(container).run({
                input: {
                    salesChannelsData: [
                        {
                            name: "Default Sales Channel",
                        },
                    ],
                },
            });
        defaultSalesChannel = salesChannelResult;
    }

    await updateStoresWorkflow(container).run({
        input: {
            selector: { id: store.id },
            update: {
                supported_currencies: [
                    { currency_code: "usd", is_default: true },
                    { currency_code: "eur" },
                ],
                default_sales_channel_id: defaultSalesChannel[0].id,
            },
        },
    });

    // Create publishable API key (idempotent)
    logger.info("Seeding publishable API key...");
    const { data: existingKeys } = await query.graph({
        entity: "api_key",
        fields: ["id"],
        filters: { type: "publishable" },
    });

    let publishableApiKeyId = existingKeys?.[0]?.id;

    if (!publishableApiKeyId) {
        const { result: [pkResult] } = await createApiKeysWorkflow(container).run({
            input: {
                api_keys: [{
                    title: "Webshop",
                    type: "publishable",
                    created_by: "",
                }],
            },
        });
        publishableApiKeyId = pkResult.id;
    }

    await linkSalesChannelsToApiKeyWorkflow(container).run({
        input: {
            id: publishableApiKeyId,
            add: [defaultSalesChannel[0].id],
        },
    });

    logger.info("Publishable API key ready.");

    logger.info("Seeding regions...");

    const { result: regionResult } = await createRegionsWorkflow(container).run({
        input: {
            regions: [
                {
                    name: "United States",
                    currency_code: "usd",
                    countries,
                    payment_providers: ["pp_system_default"],
                },
            ],
        },
    });

    const usRegion = regionResult[0];

    logger.info("Seeding fulfillment data...");

    const { result: shippingProfileResult } =
        await createShippingProfilesWorkflow(container).run({
            input: {
                data: [
                    {
                        name: "Default Shipping Profile",
                        type: "default",
                    },
                ],
            },
        });

    const shippingProfile = shippingProfileResult[0];

    const fulfillmentSet = await fulfillmentModuleService.createFulfillmentSets({
        name: "Store Fulfillment Set",
        type: "shipping",
        service_zones: [
            {
                name: "United States",
                geo_zones: [{ country_code: "us", type: "country" }],
            },
        ],
    });

    const { result: stockLocationResult } =
        await createStockLocationsWorkflow(container).run({
            input: {
                locations: [
                    {
                        name: "Default Warehouse",
                        address: {
                            city: "New York",
                            country_code: "US",
                            address_1: "123 Main St",
                        },
                    },
                ],
            },
        });

    const stockLocation = stockLocationResult[0];

    await linkSalesChannelsToStockLocationWorkflow(container).run({
        input: {
            id: stockLocation.id,
            add: [defaultSalesChannel[0].id],
        },
    });

    await remoteLink.create({
        [Modules.STOCK_LOCATION]: {
            stock_location_id: stockLocation.id,
        },
        [Modules.FULFILLMENT]: {
            fulfillment_set_id: fulfillmentSet.id,
        },
    });

    await createShippingOptionsWorkflow(container).run({
        input: [
            {
                name: "Standard Shipping",
                price_type: "flat",
                provider_id: "manual_manual",
                service_zone_id: fulfillmentSet.service_zones[0].id,
                shipping_profile_id: shippingProfile.id,
                type: {
                    label: "Standard",
                    description: "Ship in 3-5 business days",
                    code: "standard",
                },
                prices: [
                    { currency_code: "usd", amount: 500 },
                    { currency_code: "eur", amount: 500 },
                ],
                rules: [
                    { attribute: "enabled_in_store", value: '"true"', operator: "eq" },
                    {
                        attribute: "is_return",
                        value: "false",
                        operator: "eq",
                    },
                ],
            },
            {
                name: "Express Shipping",
                price_type: "flat",
                provider_id: "manual_manual",
                service_zone_id: fulfillmentSet.service_zones[0].id,
                shipping_profile_id: shippingProfile.id,
                type: {
                    label: "Express",
                    description: "Ship in 1-2 business days",
                    code: "express",
                },
                prices: [
                    { currency_code: "usd", amount: 1500 },
                    { currency_code: "eur", amount: 1500 },
                ],
                rules: [
                    { attribute: "enabled_in_store", value: '"true"', operator: "eq" },
                    {
                        attribute: "is_return",
                        value: "false",
                        operator: "eq",
                    },
                ],
            },
        ],
    });

    logger.info("Seeding products...");

    const { result: categoryResult } =
        await createProductCategoriesWorkflow(container).run({
            input: {
                product_categories: [
                    { name: "Apparel", is_active: true },
                    { name: "Accessories", is_active: true },
                ],
            },
        });

    await createProductsWorkflow(container).run({
        input: {
            products: [
                {
                    title: "Medusa T-Shirt",
                    description:
                        "A comfortable cotton t-shirt with the Medusa logo. Perfect for developers.",
                    category_ids: [categoryResult[0].id],
                    handle: "medusa-tshirt",
                    weight: 200,
                    status: "published",
                    images: [],
                    options: [
                        { title: "Size", values: ["S", "M", "L", "XL"] },
                    ],
                    variants: [
                        {
                            title: "S",
                            sku: "MEDUSA-TSHIRT-S",
                            manage_inventory: true,
                            prices: [
                                { amount: 2500, currency_code: "usd" },
                            ],
                            options: { Size: "S" },
                        },
                        {
                            title: "M",
                            sku: "MEDUSA-TSHIRT-M",
                            manage_inventory: true,
                            prices: [
                                { amount: 2500, currency_code: "usd" },
                            ],
                            options: { Size: "M" },
                        },
                        {
                            title: "L",
                            sku: "MEDUSA-TSHIRT-L",
                            manage_inventory: true,
                            prices: [
                                { amount: 2500, currency_code: "usd" },
                            ],
                            options: { Size: "L" },
                        },
                    ],
                    sales_channels: [
                        { id: defaultSalesChannel[0].id },
                    ],
                },
                {
                    title: "Medusa Hoodie",
                    description:
                        "A warm hoodie for developers who ship at night. Cozy and stylish.",
                    category_ids: [categoryResult[0].id],
                    handle: "medusa-hoodie",
                    weight: 500,
                    status: "published",
                    images: [],
                    options: [
                        { title: "Size", values: ["M", "L", "XL"] },
                    ],
                    variants: [
                        {
                            title: "M",
                            sku: "MEDUSA-HOODIE-M",
                            manage_inventory: true,
                            prices: [
                                { amount: 4500, currency_code: "usd" },
                            ],
                            options: { Size: "M" },
                        },
                        {
                            title: "L",
                            sku: "MEDUSA-HOODIE-L",
                            manage_inventory: true,
                            prices: [
                                { amount: 4500, currency_code: "usd" },
                            ],
                            options: { Size: "L" },
                        },
                    ],
                    sales_channels: [
                        { id: defaultSalesChannel[0].id },
                    ],
                },
                {
                    title: "Medusa Coffee Mug",
                    description:
                        "Start your morning with coffee and Kubernetes. Premium ceramic mug.",
                    category_ids: [categoryResult[1].id],
                    handle: "medusa-mug",
                    weight: 400,
                    status: "published",
                    images: [],
                    options: [
                        { title: "Size", values: ["Standard", "Large"] },
                    ],
                    variants: [
                        {
                            title: "Standard",
                            sku: "MEDUSA-MUG-STD",
                            manage_inventory: true,
                            prices: [
                                { amount: 1200, currency_code: "usd" },
                            ],
                            options: { Size: "Standard" },
                        },
                        {
                            title: "Large",
                            sku: "MEDUSA-MUG-LG",
                            manage_inventory: true,
                            prices: [
                                { amount: 1800, currency_code: "usd" },
                            ],
                            options: { Size: "Large" },
                        },
                    ],
                    sales_channels: [
                        { id: defaultSalesChannel[0].id },
                    ],
                },
            ],
        },
    });

    logger.info("Demo data seeded successfully!");
}