# ezPosStorefront — hosted multi-tenant storefront renderer.
FROM node:22-alpine AS build
WORKDIR /app
ARG BACKEND_URL=http://backend:3000
ARG STOREFRONT_RENDERER_TOKEN=
ARG NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN=ezpos.store
ENV BACKEND_URL=$BACKEND_URL
ENV STOREFRONT_RENDERER_TOKEN=$STOREFRONT_RENDERER_TOKEN
ENV NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN=$NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# Runtime secrets come from docker-compose env, not the image.
ENV BACKEND_URL=http://backend:3000
COPY --from=build /app ./
EXPOSE 3002
USER node
CMD ["npx", "next", "start", "-p", "3002"]
