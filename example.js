'use strict'

const { MongoClient } = require('mongodb')
const { createCache, createStorage } = require('async-cache-dedupe')
const { MongoStorage } = require('./index')

async function main () {
  // Connect to MongoDB
  const client = new MongoClient('mongodb://localhost:27017')
  await client.connect()
  console.log('Connected to MongoDB')

  const db = client.db('test')
  const collection = db.collection('cache')

  // Create custom storage with MongoStorage
  const storage = createStorage('custom', {
    storage: new MongoStorage({ collection })
  })

  // Create cache with the custom storage
  const cache = createCache({
    ttl: 5, // 5 seconds TTL
    storage: {
      type: 'custom',
      options: { storage }
    }
  })

  // Define a cached function with references
  cache.define('getUser', {
    references: (args, key, result) => {
      return result ? [`user:${result.id}`] : null
    }
  }, async (id) => {
    console.log(`Fetching user ${id} from database...`)
    // Simulate database call
    return {
      id,
      name: `User ${id}`,
      email: `user${id}@example.com`,
      createdAt: new Date().toISOString()
    }
  })

  // Define another cached function
  cache.define('getUserPosts', {
    references: (args, key, result) => {
      return [`user:${args[0]}:posts`]
    }
  }, async (userId) => {
    console.log(`Fetching posts for user ${userId}...`)
    return [
      { id: 1, userId, title: 'First Post' },
      { id: 2, userId, title: 'Second Post' }
    ]
  })

  console.log('\n--- Example 1: Basic caching ---')
  // First call - executes function
  const user1 = await cache.getUser(1)
  console.log('First call:', user1)

  // Second call - uses cache
  const user2 = await cache.getUser(1)
  console.log('Second call (cached):', user2)

  console.log('\n--- Example 2: Multiple cached functions ---')
  const posts = await cache.getUserPosts(1)
  console.log('User posts:', posts)

  console.log('\n--- Example 3: Invalidation by reference ---')
  // Invalidate user:1 cache
  await cache.invalidate('getUser', ['user:1'])
  console.log('Invalidated cache for user:1')

  // Next call will fetch fresh data
  const user3 = await cache.getUser(1)
  console.log('After invalidation:', user3)

  console.log('\n--- Example 4: Multiple users ---')
  await cache.getUser(1)
  await cache.getUser(2)
  await cache.getUser(3)
  console.log('Cached users 1, 2, and 3')

  console.log('\n--- Example 5: Wildcard invalidation ---')
  // Invalidate all user cache entries
  const mongoStorage = storage.storage
  await mongoStorage.invalidate('user:*')
  console.log('Invalidated all user cache entries')

  console.log('\n--- Example 6: Deduplication with concurrent requests ---')
  let callCount = 0
  cache.define('slowQuery', async (id) => {
    callCount++
    console.log(`  Executing slow query ${id} (call #${callCount})`)
    await new Promise(resolve => setTimeout(resolve, 100))
    return { id, result: 'data' }
  })

  // Make 5 concurrent requests for the same key
  console.log('Making 5 concurrent requests...')
  const results = await Promise.all([
    cache.slowQuery(100),
    cache.slowQuery(100),
    cache.slowQuery(100),
    cache.slowQuery(100),
    cache.slowQuery(100)
  ])
  console.log(`Completed! Function was called ${callCount} time(s) (deduplication worked!)`)
  console.log('All results are identical:', results.every(r => r.id === 100))

  console.log('\n--- Cleanup ---')
  await cache.clear()
  console.log('Cache cleared')

  await client.close()
  console.log('Disconnected from MongoDB')
}

main().catch(console.error)
