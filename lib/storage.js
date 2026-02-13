'use strict'

const crypto = require('crypto')

/**
 * MongoDB storage adapter for async-cache-dedupe.
 * Provides distributed caching with TTL, reference-based invalidation, and deduplication.
 *
 * @class MongoStorage
 */
class MongoStorage {
  /**
   * Creates a MongoStorage instance.
   *
   * @param {Object} options - Configuration options
   * @param {Object} options.collection - MongoDB collection instance (required if db not provided)
   * @param {Object} options.db - MongoDB database instance (required if collection not provided)
   * @param {string} [options.collectionName='cache'] - Collection name (used when db is provided)
   * @param {Object} [options.invalidation] - Invalidation configuration
   * @param {Object} [options.log] - Pino-compatible logger instance
   */
  constructor (options = {}) {
    if (!options.collection && !options.db) {
      throw new Error('Either collection or db must be provided')
    }

    // Use provided collection or get from database
    this.collection = options.collection || options.db.collection(options.collectionName || 'cache')
    this.db = options.db || options.collection.s?.db
    this.log = options.log

    // Key prefixes
    this.valuePrefix = 'v:'
    this.referencePrefix = 'r:'

    // Maximum key length before hashing (MongoDB has no strict limit, but we keep consistent with couchbase)
    this.maxKeyLength = 200

    // Initialize TTL indexes
    this._initializeTTLIndexes()
  }

  /**
   * Initialize TTL indexes for automatic expiration.
   * @private
   */
  async _initializeTTLIndexes () {
    try {
      // Create TTL index on expireAt field for automatic document expiration
      await this.collection.createIndex(
        { expireAt: 1 },
        { expireAfterSeconds: 0, background: true }
      )
    } catch (error) {
      // Index might already exist, log but don't fail
      if (this.log) {
        this.log.warn({ error }, 'Failed to create TTL index')
      }
    }
  }

  /**
   * Hash a key using SHA-256.
   * Keys exceeding maxKeyLength are automatically hashed for consistency.
   *
   * @private
   * @param {string} key - Key to hash
   * @returns {string} Hashed key or original if below max length
   */
  _hashKey (key) {
    if (key.length <= this.maxKeyLength) {
      return key
    }
    return crypto.createHash('sha256').update(key).digest('hex')
  }

  /**
   * Get the full value key with prefix.
   * @private
   * @param {string} key - Original key
   * @returns {string} Prefixed and potentially hashed key
   */
  _getValueKey (key) {
    return this.valuePrefix + this._hashKey(key)
  }

  /**
   * Get the full reference key with prefix.
   * @private
   * @param {string} reference - Reference name
   * @returns {string} Prefixed and potentially hashed reference
   */
  _getReferenceKey (reference) {
    return this.referencePrefix + this._hashKey(reference)
  }

  /**
   * Calculate expiration date from TTL.
   * @private
   * @param {number} ttl - Time to live in seconds
   * @returns {Date|null} Expiration date or null for no expiration
   */
  _getExpirationDate (ttl) {
    if (!ttl || ttl <= 0) {
      return null
    }
    return new Date(Date.now() + ttl * 1000)
  }

  /**
   * Retrieve a cached value.
   *
   * @param {string} key - Cache key
   * @returns {Promise<*>} Cached value or undefined if not found
   */
  async get (key) {
    const valueKey = this._getValueKey(key)

    try {
      const doc = await this.collection.findOne({ _id: valueKey })
      return doc ? doc.value : undefined
    } catch (error) {
      if (this.log) {
        this.log.error({ error, key }, 'Failed to get value')
      }
      return undefined
    }
  }

  /**
   * Store a value with optional TTL and references.
   *
   * @param {string} key - Cache key
   * @param {*} value - Value to cache (must be serializable)
   * @param {number} ttl - Time to live in seconds (0 = no expiry)
   * @param {Array<string>} [references] - Optional reference keys for invalidation
   * @returns {Promise<void>}
   */
  async set (key, value, ttl, references) {
    const valueKey = this._getValueKey(key)
    const expireAt = this._getExpirationDate(ttl)

    const doc = {
      _id: valueKey,
      value,
      createdAt: new Date()
    }

    if (expireAt) {
      doc.expireAt = expireAt
    }

    try {
      await this.collection.replaceOne(
        { _id: valueKey },
        doc,
        { upsert: true }
      )

      // Store references if provided
      if (references && references.length > 0) {
        await this._storeReferences(key, references, ttl)
      }
    } catch (error) {
      if (this.log) {
        this.log.error({ error, key }, 'Failed to set value')
      }
      throw error
    }
  }

  /**
   * Store reference mappings for a cache entry.
   * @private
   * @param {string} key - Cache key
   * @param {Array<string>} references - Reference keys
   * @param {number} ttl - Time to live in seconds
   * @returns {Promise<void>}
   */
  async _storeReferences (key, references, ttl) {
    const expireAt = this._getExpirationDate(ttl)

    const operations = references.map(reference => {
      const referenceKey = this._getReferenceKey(reference)
      const updateDoc = {
        $addToSet: { keys: key },
        $setOnInsert: { createdAt: new Date() }
      }

      if (expireAt) {
        updateDoc.$set = { expireAt }
      }

      return {
        updateOne: {
          filter: { _id: referenceKey },
          update: updateDoc,
          upsert: true
        }
      }
    })

    try {
      await this.collection.bulkWrite(operations, { ordered: false })
    } catch (error) {
      if (this.log) {
        this.log.warn({ error, key, references }, 'Failed to store references')
      }
    }
  }

  /**
   * Remove a cached value.
   *
   * @param {string} key - Cache key to remove
   * @returns {Promise<void>}
   */
  async remove (key) {
    const valueKey = this._getValueKey(key)

    try {
      await this.collection.deleteOne({ _id: valueKey })
    } catch (error) {
      if (this.log) {
        this.log.error({ error, key }, 'Failed to remove value')
      }
    }
  }

  /**
   * Invalidate cache entries by references.
   * Supports both exact match and wildcard patterns (e.g., 'user:*').
   *
   * @param {string|Array<string>} references - Reference(s) to invalidate
   * @returns {Promise<void>}
   */
  async invalidate (references) {
    const refs = Array.isArray(references) ? references : [references]

    for (const reference of refs) {
      if (reference.includes('*')) {
        await this._invalidateByPattern(reference)
      } else {
        await this._invalidateByReference(reference)
      }
    }
  }

  /**
   * Invalidate by exact reference match.
   * @private
   * @param {string} reference - Reference to invalidate
   * @returns {Promise<void>}
   */
  async _invalidateByReference (reference) {
    const referenceKey = this._getReferenceKey(reference)

    try {
      // Get all keys associated with this reference
      const refDoc = await this.collection.findOne({ _id: referenceKey })

      if (!refDoc || !refDoc.keys) {
        return
      }

      // Remove all associated cache entries
      const valueKeys = refDoc.keys.map(key => this._getValueKey(key))
      if (valueKeys.length > 0) {
        await this.collection.deleteMany({
          _id: { $in: valueKeys }
        })
      }

      // Remove the reference document itself
      await this.collection.deleteOne({ _id: referenceKey })
    } catch (error) {
      if (this.log) {
        this.log.error({ error, reference }, 'Failed to invalidate by reference')
      }
    }
  }

  /**
   * Invalidate by pattern match (wildcard support).
   * @private
   * @param {string} pattern - Pattern with wildcards (e.g., 'user:*')
   * @returns {Promise<void>}
   */
  async _invalidateByPattern (pattern) {
    try {
      // Convert wildcard pattern to regex
      const regexPattern = '^' + this.referencePrefix + pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')

      // Find all matching reference documents
      const refDocs = await this.collection.find({
        _id: { $regex: regexPattern }
      }).toArray()

      if (refDocs.length === 0) {
        return
      }

      // Collect all keys from all matching references
      const allKeys = new Set()
      const referenceIds = []

      for (const refDoc of refDocs) {
        referenceIds.push(refDoc._id)
        if (refDoc.keys) {
          refDoc.keys.forEach(key => allKeys.add(key))
        }
      }

      // Remove all associated cache entries
      if (allKeys.size > 0) {
        const valueKeys = Array.from(allKeys).map(key => this._getValueKey(key))
        await this.collection.deleteMany({
          _id: { $in: valueKeys }
        })
      }

      // Remove all reference documents
      if (referenceIds.length > 0) {
        await this.collection.deleteMany({
          _id: { $in: referenceIds }
        })
      }
    } catch (error) {
      if (this.log) {
        this.log.error({ error, pattern }, 'Failed to invalidate by pattern')
      }
    }
  }

  /**
   * Clear all cache entries.
   *
   * @returns {Promise<void>}
   */
  async clear () {
    try {
      // Remove all documents with value or reference prefix
      await this.collection.deleteMany({
        _id: {
          $regex: `^(${this.valuePrefix}|${this.referencePrefix})`
        }
      })
    } catch (error) {
      if (this.log) {
        this.log.error({ error }, 'Failed to clear cache')
      }
      throw error
    }
  }

  /**
   * Refresh/extend TTL for a key.
   *
   * @param {string} key - Cache key to refresh
   * @param {number} ttl - New TTL in seconds
   * @returns {Promise<void>}
   */
  async refresh (key, ttl) {
    const valueKey = this._getValueKey(key)
    const expireAt = this._getExpirationDate(ttl)

    try {
      const updateDoc = expireAt
        ? { $set: { expireAt } }
        : { $unset: { expireAt: '' } }

      await this.collection.updateOne(
        { _id: valueKey },
        updateDoc
      )
    } catch (error) {
      if (this.log) {
        this.log.error({ error, key }, 'Failed to refresh key')
      }
    }
  }

  /**
   * Get remaining TTL for a key in seconds.
   *
   * @param {string} key - Cache key
   * @returns {Promise<number>} TTL in seconds, 0 if no expiry or key doesn't exist
   */
  async getTTL (key) {
    const valueKey = this._getValueKey(key)

    try {
      const doc = await this.collection.findOne(
        { _id: valueKey },
        { projection: { expireAt: 1 } }
      )

      if (!doc || !doc.expireAt) {
        return 0
      }

      const ttl = Math.floor((doc.expireAt.getTime() - Date.now()) / 1000)
      return Math.max(0, ttl)
    } catch (error) {
      if (this.log) {
        this.log.error({ error, key }, 'Failed to get TTL')
      }
      return 0
    }
  }

  /**
   * Check if a key exists in the cache.
   *
   * @param {string} key - Cache key to check
   * @returns {Promise<boolean>} True if key exists
   */
  async exists (key) {
    const valueKey = this._getValueKey(key)

    try {
      const count = await this.collection.countDocuments(
        { _id: valueKey },
        { limit: 1 }
      )
      return count > 0
    } catch (error) {
      if (this.log) {
        this.log.error({ error, key }, 'Failed to check existence')
      }
      return false
    }
  }
}

module.exports = MongoStorage
