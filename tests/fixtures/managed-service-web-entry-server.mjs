#!/usr/bin/env node
import { createServer } from 'node:http'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'

const secret = randomBytes(32)
const instance = randomUUID()
const proofContract = 'cordisx.managed-service-web-entry-proof/v1'
const sourceContract = 'cordisx.managed-service-web-entry-source-result/v1'
const proof = challenge =>
  createHmac('sha256', secret)
    .update(JSON.stringify([proofContract, challenge, consoleOrigin, instance])).digest('hex')
const send = (response, value) => {
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(value))
}
const secondary = createServer((request, response) => {
  const url = new URL(request.url, consoleOrigin)
  if (url.pathname === '/proof') {
    if (request.headers.authorization || url.searchParams.size !== 1) return response.writeHead(400).end()
    return send(response, { contract: proofContract, instance, proof: proof(url.searchParams.get('challenge')) })
  }
  if (url.pathname === '/') return response.end('owned-console')
  response.writeHead(404).end()
})
await new Promise(resolve => secondary.listen(0, '127.0.0.1', resolve))
const consoleOrigin = `http://127.0.0.1:${secondary.address().port}`
const primary = createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${process.env.SERVICE_TOKEN}`) return response.writeHead(401).end()
  const url = new URL(request.url, 'http://127.0.0.1')
  if (url.pathname === '/health') return response.writeHead(204).end()
  if (url.pathname === '/console') {
    return send(response, {
      contract: sourceContract,
      status: 'available',
      origin: consoleOrigin,
      verification: { instance, proof: proof(url.searchParams.get('challenge')) },
    })
  }
  response.writeHead(404).end()
})
primary.listen(Number(process.argv[2]), '127.0.0.1')
process.on('SIGTERM', () => {
  primary.closeAllConnections()
  secondary.closeAllConnections()
  primary.close(() => secondary.close(() => process.exit(0)))
})
