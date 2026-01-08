'use strict'

const { test, before, after } = require('node:test')
const { deepStrictEqual, strictEqual, ok } = require('node:assert')
const { MongoClient } = require('mongodb')
const { createCache, createStorage } = require('async-cache-dedupe')
const { MongoStorage } = require('..')

const MONGODB_URL = process.env.MONGODB_URL || 'mongodb://localhost:27017'
const DATABASE_NAME = process.env.MONGODB_DATABASE || 'test'
const COLLECTION_NAME = process.env.MONGODB_COLLECTION || 'cache'

let client
let db
let collection

before(async () => {
  try {
    client = new MongoClient(MONGODB_URL, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000
    })
    await client.connect()
    db = client.db(DATABASE_NAME)
    collection = db.collection(COLLECTION_NAME)

    // Clean up before tests
    await collection.deleteMany({})
  } catch (error) {
    console.error('Failed to connect to MongoDB. Is MongoDB running?')
    console.error('Run: bash scripts/setup-mongodb.sh')
    console.error('Error:', error.message)
    throw error
  }
})

after(async () => {
  // Clean up after tests
  if (client) {
    try {
      await collection.deleteMany({})
      await client.close()
    } catch (error) {
      // Ignore cleanup errors
    }
  }
})

test('Integration: MongoStorage basic operations', async (t) => {
  await t.test('should set and get a value', async () => {
    const storage = new MongoStorage({ collection })

    await storage.set('integration-test-1', { foo: 'bar', num: 42 }, 60)
    const value = await storage.get('integration-test-1')

    deepStrictEqual(value, { foo: 'bar', num: 42 })

    // Clean up
    await storage.remove('integration-test-1')
  })

  await t.test('should handle complex values', async () => {
    const storage = new MongoStorage({ collection })

    const complexValue = {
      user: { id: 1, name: 'John Doe', email: 'john@example.com' },
      preferences: { theme: 'dark', notifications: true },
      tags: ['admin', 'user'],
      metadata: { created: new Date().toISOString() }
    }

    await storage.set('complex-key', complexValue, 60)
    const value = await storage.get('complex-key')

    deepStrictEqual(value, complexValue)

    // Clean up
    await storage.remove('complex-key')
  })

  await t.test('should return undefined for non-existent key', async () => {
    const storage = new MongoStorage({ collection })

    const value = await storage.get('non-existent-key')
    strictEqual(value, undefined)
  })

  await t.test('should remove a key', async () => {
    const storage = new MongoStorage({ collection })

    await storage.set('remove-test', { data: 'test' }, 60)
    await storage.remove('remove-test')

    const value = await storage.get('remove-test')
    strictEqual(value, undefined)
  })
})

test('Integration: MongoStorage TTL operations', async (t) => {
  await t.test('should handle TTL correctly', async () => {
    const storage = new MongoStorage({ collection })

    await storage.set('ttl-test', { data: 'test' }, 5)
    const ttl = await storage.getTTL('ttl-test')

    ok(ttl > 0 && ttl <= 5, `TTL should be between 0 and 5, got ${ttl}`)

    // Clean up
    await storage.remove('ttl-test')
  })

  await t.test('should refresh TTL', async () => {
    const storage = new MongoStorage({ collection })

    await storage.set('refresh-test', { data: 'test' }, 10)
    const ttl1 = await storage.getTTL('refresh-test')

    await storage.refresh('refresh-test', 60)
    const ttl2 = await storage.getTTL('refresh-test')

    ok(ttl2 > ttl1, `TTL after refresh (${ttl2}) should be greater than before (${ttl1})`)

    // Clean up
    await storage.remove('refresh-test')
  })

  await t.test('should check if key exists', async () => {
    const storage = new MongoStorage({ collection })

    await storage.set('exists-test', { data: 'test' }, 60)
    const exists1 = await storage.exists('exists-test')
    strictEqual(exists1, true)

    await storage.remove('exists-test')
    const exists2 = await storage.exists('exists-test')
    strictEqual(exists2, false)
  })
})

test('Integration: MongoStorage references and invalidation', async (t) => {
  await t.test('should store and invalidate by reference', async () => {
    const storage = new MongoStorage({ collection })

    await storage.set('user-1', { id: 1, name: 'Alice' }, 60, ['user:1'])
    await storage.set('user-2', { id: 2, name: 'Bob' }, 60, ['user:2'])

    await storage.invalidate('user:1')

    const value1 = await storage.get('user-1')
    const value2 = await storage.get('user-2')

    strictEqual(value1, undefined)
    deepStrictEqual(value2, { id: 2, name: 'Bob' })

    // Clean up
    await storage.remove('user-2')
  })

  await t.test('should invalidate multiple keys by same reference', async () => {
    const storage = new MongoStorage({ collection })

    await storage.set('post-1', { userId: 1, title: 'Post 1' }, 60, ['user:1'])
    await storage.set('post-2', { userId: 1, title: 'Post 2' }, 60, ['user:1'])
    await storage.set('post-3', { userId: 2, title: 'Post 3' }, 60, ['user:2'])

    await storage.invalidate('user:1')

    const value1 = await storage.get('post-1')
    const value2 = await storage.get('post-2')
    const value3 = await storage.get('post-3')

    strictEqual(value1, undefined)
    strictEqual(value2, undefined)
    deepStrictEqual(value3, { userId: 2, title: 'Post 3' })

    // Clean up
    await storage.remove('post-3')
  })

  await t.test('should invalidate by wildcard pattern', async () => {
    const storage = new MongoStorage({ collection })

    await storage.set('item-1', { type: 'A' }, 60, ['product:123'])
    await storage.set('item-2', { type: 'B' }, 60, ['product:456'])
    await storage.set('item-3', { type: 'C' }, 60, ['category:789'])

    await storage.invalidate('product:*')

    const value1 = await storage.get('item-1')
    const value2 = await storage.get('item-2')
    const value3 = await storage.get('item-3')

    strictEqual(value1, undefined)
    strictEqual(value2, undefined)
    deepStrictEqual(value3, { type: 'C' })

    // Clean up
    await storage.remove('item-3')
  })

  await t.test('should handle multiple references for one key', async () => {
    const storage = new MongoStorage({ collection })

    await storage.set('multi-ref', { data: 'test' }, 60, ['ref:1', 'ref:2', 'ref:3'])

    const value1 = await storage.get('multi-ref')
    deepStrictEqual(value1, { data: 'test' })

    await storage.invalidate('ref:2')

    const value2 = await storage.get('multi-ref')
    strictEqual(value2, undefined)
  })
})

test('Integration: MongoStorage clear', async (t) => {
  await t.test('should clear all cache entries', async () => {
    const storage = new MongoStorage({ collection })

    await storage.set('clear-1', { data: '1' }, 60, ['ref:1'])
    await storage.set('clear-2', { data: '2' }, 60, ['ref:2'])
    await storage.set('clear-3', { data: '3' }, 60, ['ref:3'])

    await storage.clear()

    const value1 = await storage.get('clear-1')
    const value2 = await storage.get('clear-2')
    const value3 = await storage.get('clear-3')

    strictEqual(value1, undefined)
    strictEqual(value2, undefined)
    strictEqual(value3, undefined)

    // Verify collection is empty of cache entries
    const count = await collection.countDocuments({
      _id: { $regex: '^(v:|r:)' }
    })
    strictEqual(count, 0)
  })
})

test('Integration: async-cache-dedupe integration', async (t) => {
  await t.test('should work with async-cache-dedupe using createStorage', async () => {
    // Create custom storage with MongoStorage
    const storage = createStorage('custom', {
      storage: new MongoStorage({ collection })
    })

    // Create cache with the custom storage
    const cache = createCache({
      ttl: 60,
      storage: {
        type: 'custom',
        options: { storage }
      }
    })

    let callCount = 0
    cache.define('getUser', {
      references: (args, key, result) => result ? [`user:${result.id}`] : null
    }, async (id) => {
      callCount++
      return { id, name: `User ${id}` }
    })

    // First call - should execute function
    const user1 = await cache.getUser(1)
    deepStrictEqual(user1, { id: 1, name: 'User 1' })
    strictEqual(callCount, 1)

    // Second call - should use cache
    const user2 = await cache.getUser(1)
    deepStrictEqual(user2, { id: 1, name: 'User 1' })
    strictEqual(callCount, 1)

    // Invalidate by reference
    await cache.invalidate('getUser', ['user:1'])

    // Third call - should execute function again
    const user3 = await cache.getUser(1)
    deepStrictEqual(user3, { id: 1, name: 'User 1' })
    strictEqual(callCount, 2)

    // Clean up
    await cache.clear()
  })

  await t.test('should handle deduplication with concurrent requests', async () => {
    // Create custom storage with MongoStorage
    const storage = createStorage('custom', {
      storage: new MongoStorage({ collection })
    })

    // Create cache with the custom storage
    const cache = createCache({
      ttl: 60,
      storage: {
        type: 'custom',
        options: { storage }
      }
    })

    let callCount = 0
    cache.define('slowQuery', async (id) => {
      callCount++
      await new Promise(resolve => setTimeout(resolve, 100))
      return { id, result: 'data' }
    })

    // Make 5 concurrent requests for the same key
    const results = await Promise.all([
      cache.slowQuery(1),
      cache.slowQuery(1),
      cache.slowQuery(1),
      cache.slowQuery(1),
      cache.slowQuery(1)
    ])

    // Should only call the function once due to deduplication
    strictEqual(callCount, 1)
    results.forEach(result => {
      deepStrictEqual(result, { id: 1, result: 'data' })
    })

    // Clean up
    await cache.clear()
  })
})

test('Integration: Key hashing with long keys', async (t) => {
  await t.test('should handle very long keys', async () => {
    const storage = new MongoStorage({ collection })

    const longKey = 'x'.repeat(300)
    await storage.set(longKey, { data: 'test' }, 60)

    const value = await storage.get(longKey)
    deepStrictEqual(value, { data: 'test' })

    const exists = await storage.exists(longKey)
    strictEqual(exists, true)

    // Clean up
    await storage.remove(longKey)
  })
})
