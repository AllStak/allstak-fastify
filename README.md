# @allstak/fastify

Beta standalone AllStak SDK for Fastify request and error capture.

This package is independently installable and does not depend on another `@allstak/*` SDK at runtime.

```sh
npm install @allstak/fastify@beta
```

```ts
import Fastify from "fastify";
import { allstakFastify } from "@allstak/fastify";

const app = Fastify();
await app.register(allstakFastify, {
  dsn: process.env.ALLSTAK_DSN,
  endpoint: "https://api.allstak.sa",
  release: process.env.RELEASE,
  environment: process.env.NODE_ENV,
});
```
