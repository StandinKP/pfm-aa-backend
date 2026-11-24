FROM oven/bun:1.4.4-slim
WORKDIR /app
COPY package.json .
COPY src ./src
COPY data ./data
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["bun", "src/main.ts"]
