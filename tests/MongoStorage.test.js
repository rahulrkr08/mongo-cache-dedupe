'use strict'

const { test } = require('node:test')
const { deepStrictEqual, strictEqual, ok } = require('node:assert')
const { MongoStorage } = require('..')

// Mock MongoDB collection
class MockCollection {
  constructor () {
    this.data = new Map()
    this.s = { db: {} }
  }

  async findOne (query, options) {
    const id = query._id
    if (id instanceof RegExp) {
      for (const [key, value] of this.data.entries()) {
        if (id.test(key)) {
          return this._filterProjection(value, options?.projection)
        }
      }
      return null
    }
    const doc = this.data.get(id)
    return doc ? this._filterProjection(doc, options?.projection) : null
  }

  find (query) {
    const results = []
    if (query._id?.$regex) {
      const regex = new RegExp(query._id.$regex)
      for (const [key, value] of this.data.entries()) {
        if (regex.test(key)) {
          results.push(value)
        }
      }
    } else if (query._id?.$in) {
      for (const id of query._id.$in) {
        const doc = this.data.get(id)
        if (doc) results.push(doc)
      }
    }
    return {
      toArray: async () => results
    }
  }

  async replaceOne (filter, doc, options) {
    if (options?.upsert) {
      this.data.set(doc._id, { ...doc })
    }
    return { acknowledged: true, modifiedCount: 1 }
  }

  async updateOne (filter, update, options) {
    const existing = this.data.get(filter._id)

    if (!existing && options?.upsert) {
      const newDoc = { _id: filter._id }
      if (update.$setOnInsert) {
        Object.assign(newDoc, update.$setOnInsert)
      }
      if (update.$set) {
        Object.assign(newDoc, update.$set)
      }
      if (update.$addToSet) {
        for (const [key, value] of Object.entries(update.$addToSet)) {
          newDoc[key] = [value]
        }
      }
      this.data.set(filter._id, newDoc)
    } else if (existing) {
      if (update.$set) {
        Object.assign(existing, update.$set)
      }
      if (update.$unset) {
        for (const key of Object.keys(update.$unset)) {
          delete existing[key]
        }
      }
      if (update.$addToSet) {
        for (const [key, value] of Object.entries(update.$addToSet)) {
          if (!existing[key]) {
            existing[key] = []
          }
          if (!existing[key].includes(value)) {
            existing[key].push(value)
          }
        }
      }
    }
    return { acknowledged: true, modifiedCount: 1 }
  }

  async deleteOne (filter) {
    this.data.delete(filter._id)
    return { acknowledged: true, deletedCount: 1 }
  }

  async deleteMany (filter) {
    let count = 0
    if (filter._id?.$regex) {
      const regex = new RegExp(filter._id.$regex)
      for (const key of this.data.keys()) {
        if (regex.test(key)) {
          this.data.delete(key)
          count++
        }
      }
    } else if (filter._id?.$in) {
      for (const id of filter._id.$in) {
        if (this.data.delete(id)) {
          count++
        }
      }
    }
    return { acknowledged: true, deletedCount: count }
  }

  async countDocuments (filter) {
    return this.data.has(filter._id) ? 1 : 0
  }

  async createIndex () {
    return 'expireAt_1'
  }

  _filterProjection (doc, projection) {
    if (!projection) return doc
    const filtered = {}
    for (const key of Object.keys(projection)) {
      if (projection[key] === 1 && doc[key] !== undefined) {
        filtered[key] = doc[key]
      }
    }
    return Object.keys(filtered).length > 0 ? filtered : doc
  }
}

test('MongoStorage constructor', async (t) => {
  await t.test('should throw error if neither collection nor db provided', () => {
    try {
      new MongoStorage({}) // eslint-disable-line no-new
      ok(false, 'Should have thrown error')
    } catch (error) {
      strictEqual(error.message, 'Either collection or db must be provided')
    }
  })

  await t.test('should accept collection', () => {
    const collection = new MockCollection()
    const storage = new MongoStorage({ collection })
    ok(storage)
    strictEqual(storage.collection, collection)
  })

  await t.test('should accept db and create collection', () => {
    const collection = new MockCollection()
    const db = {
      collection: (name) => {
        strictEqual(name, 'cache')
        return collection
      }
    }
    const storage = new MongoStorage({ db })
    ok(storage)
    strictEqual(storage.collection, collection)
  })

  await t.test('should accept custom collection name', () => {
    const collection = new MockCollection()
    const db = {
      collection: (name) => {
        strictEqual(name, 'mycache')
        return collection
      }
    }
    const storage = new MongoStorage({ db, collectionName: 'mycache' })
    ok(storage)
  })
})

test('MongoStorage get/set', async (t) => {
  await t.test('should set and get a value', async () => {
    const collection = new MockCollection()
    const storage = new MongoStorage({ collection })

    await storage.set('test-key', { foo: 'bar' }, 60)
    const value = await storage.get('test-key')
    deepStrictEqual(value, { foo: 'bar' })
  })

  await t.test('should return undefined for non-existent key', async () => {
    const collection = new MockCollection()
    const storage = new MongoStorage({ collection })

    const value = await storage.get('non-existent')
    strictEqual(value, undefined)
  })

  await t.test('should handle TTL of 0 (no expiry)', async () => {
    const collection = new MockCollection()
    const storage = new MongoStorage({ collection })

    await storage.set('test-key', { foo: 'bar' }, 0)
    const doc = collection.data.get('v:test-key')
    ok(doc)
    strictEqual(doc.expireAt, undefined)
  })

  await t.test('should set expireAt with positive TTL', async () => {
    const collection = new MockCollection()
    const storage = new MongoStorage({ collection })

    const before = Date.now()
    await storage.set('test-key', { foo: 'bar' }, 60)
    const after = Date.now()

    const doc = collection.data.get('v:test-key')
    ok(doc.expireAt instanceof Date)
    ok(doc.expireAt.getTime() >= before + 60000)
    ok(doc.expireAt.getTime() <= after + 60000)
  })
})

test('MongoStorage remove', async (t) => {
  await t.test('should remove a key', async () => {
    const collection = new MockCollection()
    const storage = new MongoStorage({ collection })

    await storage.set('test-key', { foo: 'bar' }, 60)
    await storage.remove('test-key')
    const value = await storage.get('test-key')
    strictEqual(value, undefined)
  })

  await t.test('should handle removing non-existent key', async () => {
    const collection = new MockCollection()
    const storage = new MongoStorage({ collection })

    await storage.remove('non-existent')
    const value = await storage.get('non-existent')
    strictEqual(value, undefined)
  })
})

test('MongoStorage references', async (t) => {
  await t.test('should store references', async () => {
    const collection = new MockCollection()
    const storage = new MongoStorage({ collection })

    await storage.set('key1', { id: 1 }, 60, ['user:1', 'tenant:1'])

    const ref1 = collection.data.get('r:user:1')
    ok(ref1)
    deepStrictEqual(ref1.keys, ['key1'])

    const ref2 = collection.data.get('r:tenant:1')
    ok(ref2)
    deepStrictEqual(ref2.keys, ['key1'])
  })

  await t.test('should add multiple keys to same reference', async () => {
    const collection = new MockCollection()
    const storage = new MongoStorage({ collection })

    await storage.set('key1', { id: 1 }, 60, ['user:1'])
    await storage.set('key2', { id: 2 }, 60, ['user:1'])

    const ref = collection.data.get('r:user:1')
    ok(ref)
    strictEqual(ref.keys.length, 2)
    ok(ref.keys.includes('key1'))
    ok(ref.keys.includes('key2'))
  })
})

test('MongoStorage invalidate', async (t) => {
  await t.test('should invalidate by exact reference', async () => {
    const collection = new MockCollection()
    const storage = new MongoStorage({ collection })

    await storage.set('key1', { id: 1 }, 60, ['user:1'])
    await storage.set('key2', { id: 2 }, 60, ['user:2'])

    await storage.invalidate('user:1')

    const value1 = await storage.get('key1')
    const value2 = await storage.get('key2')
    strictEqual(value1, undefined)
    deepStrictEqual(value2, { id: 2 })
  })

  await t.test('should invalidate multiple keys by reference', async () => {
    const collection = new MockCollection()
    const storage = new MongoStorage({ collection })

    await storage.set('key1', { id: 1 }, 60, ['user:1'])
    await storage.set('key2', { id: 2 }, 60, ['user:1'])
    await storage.set('key3', { id: 3 }, 60, ['user:2'])

    await storage.invalidate('user:1')

    const value1 = await storage.get('key1')
    const value2 = await storage.get('key2')
    const value3 = await storage.get('key3')
    strictEqual(value1, undefined)
    strictEqual(value2, undefined)
    deepStrictEqual(value3, { id: 3 })
  })

  await t.test('should invalidate by wildcard pattern', async () => {
    const collection = new MockCollection()
    const storage = new MongoStorage({ collection })

    await storage.set('key1', { id: 1 }, 60, ['user:1'])
    await storage.set('key2', { id: 2 }, 60, ['user:2'])
    await storage.set('key3', { id: 3 }, 60, ['tenant:1'])

    await storage.invalidate('user:*')

    const value1 = await storage.get('key1')
    const value2 = await storage.get('key2')
    const value3 = await storage.get('key3')
    strictEqual(value1, undefined)
    strictEqual(value2, undefined)
    deepStrictEqual(value3, { id: 3 })
  })

  await t.test('should handle array of references', async () => {
    const collection = new MockCollection()
    const storage = new MongoStorage({ collection })

    await storage.set('key1', { id: 1 }, 60, ['user:1'])
    await storage.set('key2', { id: 2 }, 60, ['user:2'])
    await storage.set('key3', { id: 3 }, 60, ['tenant:1'])

    await storage.invalidate(['user:1', 'tenant:1'])

    const value1 = await storage.get('key1')
    const value2 = await storage.get('key2')
    const value3 = await storage.get('key3')
    strictEqual(value1, undefined)
    deepStrictEqual(value2, { id: 2 })
    strictEqual(value3, undefined)
  })
})

test('MongoStorage clear', async (t) => {
  await t.test('should clear all cache entries', async () => {
    const collection = new MockCollection()
    const storage = new MongoStorage({ collection })

    await storage.set('key1', { id: 1 }, 60, ['user:1'])
    await storage.set('key2', { id: 2 }, 60, ['user:2'])

    await storage.clear()

    const value1 = await storage.get('key1')
    const value2 = await storage.get('key2')
    strictEqual(value1, undefined)
    strictEqual(value2, undefined)
    strictEqual(collection.data.size, 0)
  })
})

test('MongoStorage refresh', async (t) => {
  await t.test('should refresh TTL', async () => {
    const collection = new MockCollection()
    const storage = new MongoStorage({ collection })

    await storage.set('test-key', { foo: 'bar' }, 60)
    await storage.refresh('test-key', 120)

    const doc = collection.data.get('v:test-key')
    ok(doc.expireAt instanceof Date)
    const ttl = Math.floor((doc.expireAt.getTime() - Date.now()) / 1000)
    ok(ttl > 60 && ttl <= 120)
  })

  await t.test('should remove expiry when TTL is 0', async () => {
    const collection = new MockCollection()
    const storage = new MongoStorage({ collection })

    await storage.set('test-key', { foo: 'bar' }, 60)
    await storage.refresh('test-key', 0)

    const doc = collection.data.get('v:test-key')
    strictEqual(doc.expireAt, undefined)
  })
})

test('MongoStorage getTTL', async (t) => {
  await t.test('should return TTL in seconds', async () => {
    const collection = new MockCollection()
    const storage = new MongoStorage({ collection })

    await storage.set('test-key', { foo: 'bar' }, 60)
    const ttl = await storage.getTTL('test-key')
    ok(ttl > 0 && ttl <= 60)
  })

  await t.test('should return 0 for non-existent key', async () => {
    const collection = new MockCollection()
    const storage = new MongoStorage({ collection })

    const ttl = await storage.getTTL('non-existent')
    strictEqual(ttl, 0)
  })

  await t.test('should return 0 for key without expiry', async () => {
    const collection = new MockCollection()
    const storage = new MongoStorage({ collection })

    await storage.set('test-key', { foo: 'bar' }, 0)
    const ttl = await storage.getTTL('test-key')
    strictEqual(ttl, 0)
  })
})

test('MongoStorage exists', async (t) => {
  await t.test('should return true for existing key', async () => {
    const collection = new MockCollection()
    const storage = new MongoStorage({ collection })

    await storage.set('test-key', { foo: 'bar' }, 60)
    const exists = await storage.exists('test-key')
    strictEqual(exists, true)
  })

  await t.test('should return false for non-existent key', async () => {
    const collection = new MockCollection()
    const storage = new MongoStorage({ collection })

    const exists = await storage.exists('non-existent')
    strictEqual(exists, false)
  })
})

test('MongoStorage key hashing', async (t) => {
  await t.test('should hash long keys', async () => {
    const collection = new MockCollection()
    const storage = new MongoStorage({ collection })

    const longKey = 'a'.repeat(250)
    await storage.set(longKey, { foo: 'bar' }, 60)

    // Key should be hashed (64 char hex + prefix)
    const hashedKeys = Array.from(collection.data.keys()).filter(k => k.startsWith('v:'))
    strictEqual(hashedKeys.length, 1)
    strictEqual(hashedKeys[0].length, 66) // 'v:' + 64 char hash

    const value = await storage.get(longKey)
    deepStrictEqual(value, { foo: 'bar' })
  })

  await t.test('should not hash short keys', async () => {
    const collection = new MockCollection()
    const storage = new MongoStorage({ collection })

    await storage.set('short-key', { foo: 'bar' }, 60)

    const keys = Array.from(collection.data.keys()).filter(k => k.startsWith('v:'))
    strictEqual(keys[0], 'v:short-key')
  })
})
