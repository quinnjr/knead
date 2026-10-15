# @hpmws/cors

`CorsModule.forRoot({ origin, credentials, … })`: global CORS middleware that answers preflight requests before routing and rejects unsafe configurations at startup (`origin: '*'` with credentials, or `'*'` inside an origin list).

`bun add @hpmws/cors`. Licensed MIT OR Apache-2.0.
