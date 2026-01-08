#!/usr/bin/env node
'use strict'

const { MongoClient } = require('mongodb')

const MONGODB_URL = process.env.MONGODB_URL || 'mongodb://localhost:27017'
const MAX_ATTEMPTS = 30
const RETRY_DELAY = 1000 // 1 second

async function waitForMongoDB () {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const client = new MongoClient(MONGODB_URL, {
        serverSelectionTimeoutMS: 2000,
        connectTimeoutMS: 2000
      })

      await client.connect()
      await client.db('admin').command({ ping: 1 })
      await client.close()

      console.log('✓ MongoDB is ready!')
      process.exit(0)
    } catch (error) {
      if (attempt < MAX_ATTEMPTS) {
        console.log(`⏳ Waiting for MongoDB... (attempt ${attempt}/${MAX_ATTEMPTS})`)
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY))
      } else {
        console.error('✗ MongoDB failed to start after', MAX_ATTEMPTS, 'attempts')
        console.error('Error:', error.message)
        process.exit(1)
      }
    }
  }
}

waitForMongoDB()
