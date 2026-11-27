# Muzo Data addon for BitChord: small, dependency-free Node image.
#   docker build -t muzo-bitchord-addon .
#   docker run -d -p 8787:8787 -e MEDIA_SECRET=$(openssl rand -hex 32) muzo-bitchord-addon
FROM node:20-alpine

ENV NODE_ENV=production \
    PORT=8787 \
    MEDIA_TTL_SECONDS=1800

WORKDIR /app

# No npm install needed: the addon has zero dependencies.
COPY --chown=node:node package.json server.mjs ./
COPY --chown=node:node src ./src

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
