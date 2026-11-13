import { writeFile } from 'node:fs/promises'
import Fastify from 'fastify'
import swagger from '@fastify/swagger'
import { registerAppRoutes } from '../src/app.js'

const app = Fastify()
try {
  // Swagger 9 supports Fastify 5. Register before routes for schema discovery.
  await app.register(swagger, {
    // Swagger 9 assumes every schema.body is mandatory. This route's existing
    // preValidation explicitly permits no body, so correct that documentation flag.
    transformObject(document) {
      if ('openapiObject' in document) {
        const body = document.openapiObject.paths?.['/v1/github-token']?.post?.requestBody
        if (body && !('$ref' in body)) {
          body.required = false
        }
        return document.openapiObject
      }
      return document.swaggerObject
    },
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'GitHub token broker',
        version: '0.1.0',
        description: 'Exchange projected Kubernetes pod credentials for GitHub tokens scoped to a repository and role.',
      },
      components: {
        securitySchemes: {
          podBearer: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'Projected Kubernetes token',
            description: 'Pod-bound projected ServiceAccount token with audience token-broker.',
          },
        },
      },
    },
  })
  // Only schemas are read. Fail immediately if generation ever invokes an adapter.
  const unused = async (): Promise<never> => {
    throw new Error('OpenAPI generation must not call dependencies')
  }
  registerAppRoutes(app, {
    tokenValidator: unused,
    podLookup: unused,
    tokenIssuer: unused,
    repositories: {},
  })
  await app.ready()
  await writeFile(new URL('../docs-site/openapi.json', import.meta.url), `${JSON.stringify(app.swagger(), null, 2)}\n`)
} finally {
  await app.close()
}
