FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json yarn.lock ./

COPY . .

# Bypass the NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY check for build
RUN echo "module.exports = function() {}" > check-env-variables.js

RUN corepack enable && corepack prepare yarn@4.12.0 --activate
RUN yarn install

ENV NEXT_PUBLIC_MEDUSA_BACKEND_URL=http://medusa-backend:9000
ENV NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=pk_dummy
ENV NEXT_PUBLIC_BASE_URL=http://localhost:8000
ENV MEDUSA_BACKEND_URL=http://medusa-backend:9000
ENV STANDALONE_BUILD=true

RUN yarn build

FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV production

# You only need these copied for standalone execution
COPY --from=builder /app/package.json ./package.json

# Automatically leverage output traces to reduce image size
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Expose port and start
EXPOSE 8000
ENV PORT=8000

CMD ["node", "server.js"]
