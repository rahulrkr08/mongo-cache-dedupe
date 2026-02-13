# mongo-cache-dedupe

MongoDB storage adapter for [async-cache-dedupe](https://github.com/mcollina/async-cache-dedupe).

## Features

- Full async-cache-dedupe storage interface support
- TTL (Time To Live) with MongoDB's native expiration
- Reference-based cache invalidation
- Wildcard pattern support for bulk invalidation
- Automatic key hashing for long keys
- Deduplication of concurrent requests
- TypeScript-friendly

## Installation

```bash
npm install mongo-cache-dedupe mongodb
```

## Usage

### Basic Setup

```javascript
const { MongoClient } = require('mongodb')
const { createCache, createStorage } = require('async-cache-dedupe')
const { MongoStorage } = require('mongo-cache-dedupe')

const client = new MongoClient('mongodb://localhost:27017')
await client.connect()

const db = client.db('myapp')
const collection = db.collection('cache')

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

// Define cached function
cache.define('getUser', async (id) => {
  // This will only be called on cache miss
  return { id, name: `User ${id}` }
})

// Use the cache
const user = await cache.getUser(1)
```

### With References for Invalidation

```javascript
cache.define('getUser', {
  references: (args, key, result) => {
    // Return references for this cache entry
    return result ? [`user:${result.id}`] : null
  }
}, async (id) => {
  const user = await db.collection('users').findOne({ _id: id })
  return user
})

// Fetch user (caches result)
const user = await cache.getUser(1)

// Invalidate all cache entries with reference 'user:1'
await cache.invalidate('getUser', ['user:1'])

// Next call will fetch fresh data
const freshUser = await cache.getUser(1)
```

### Wildcard Invalidation

```javascript
// Cache multiple users
await cache.getUser(1)
await cache.getUser(2)
await cache.getUser(3)

// Invalidate all user-related cache entries
await storage.invalidate('user:*')

// All user cache entries are now invalidated
```

## API

### Constructor

#### `new MongoStorage(options)`

Creates a new MongoStorage instance.

**Options:**
- `collection` (Object, required if `db` not provided): MongoDB collection instance
- `db` (Object, required if `collection` not provided): MongoDB database instance
- `collectionName` (String, optional): Collection name when using `db` option (default: `'cache'`)
- `invalidation` (Object, optional): Invalidation configuration

**Examples:**

```javascript
// Using collection
const storage = new MongoStorage({
  collection: db.collection('cache')
})

// Using database (will use default 'cache' collection)
const storage = new MongoStorage({
  db: db
})

// Using database with custom collection name
const storage = new MongoStorage({
  db: db,
  collectionName: 'my_cache'
})

```

### Methods

#### `async get(key)`

Retrieve a cached value.

**Parameters:**
- `key` (String): Cache key

**Returns:** `Promise<*>` - Cached value or `undefined` if not found

```javascript
const value = await storage.get('my-key')
```

#### `async set(key, value, ttl, references)`

Store a value with optional TTL and references.

**Parameters:**
- `key` (String): Cache key
- `value` (*): Value to cache (must be serializable)
- `ttl` (Number): Time to live in seconds (0 = no expiry)
- `references` (Array<String>, optional): Reference keys for invalidation

```javascript
await storage.set('my-key', { foo: 'bar' }, 60)
await storage.set('user:1', userData, 60, ['user:1', 'tenant:1'])
```

#### `async remove(key)`

Remove a cached value.

**Parameters:**
- `key` (String): Cache key to remove

```javascript
await storage.remove('my-key')
```

#### `async invalidate(references)`

Invalidate cache entries by references. Supports wildcards.

**Parameters:**
- `references` (String | Array<String>): Reference(s) to invalidate

```javascript
// Single reference
await storage.invalidate('user:1')

// Multiple references
await storage.invalidate(['user:1', 'user:2'])

// Wildcard pattern
await storage.invalidate('user:*')
```

#### `async clear()`

Clear all cache entries.

```javascript
await storage.clear()
```

#### `async refresh(key, ttl)`

Refresh/extend TTL for a key.

**Parameters:**
- `key` (String): Cache key
- `ttl` (Number): New TTL in seconds

```javascript
await storage.refresh('my-key', 120)
```

#### `async getTTL(key)`

Get remaining TTL for a key.

**Parameters:**
- `key` (String): Cache key

**Returns:** `Promise<Number>` - TTL in seconds, 0 if no expiry or key doesn't exist

```javascript
const ttl = await storage.getTTL('my-key')
console.log(`Key expires in ${ttl} seconds`)
```

#### `async exists(key)`

Check if a key exists in the cache.

**Parameters:**
- `key` (String): Cache key

**Returns:** `Promise<Boolean>` - `true` if key exists

```javascript
const exists = await storage.exists('my-key')
```

## How It Works

### Data Model

The adapter uses a prefix-based organization:
- **Value documents**: `v:{key}` - Store cached values
- **Reference documents**: `r:{reference}` - Store key mappings for invalidation

**Value Document:**
```javascript
{
  _id: "v:user:1",
  value: { id: 1, name: "John Doe" },
  createdAt: ISODate("2024-01-01T00:00:00Z"),
  expireAt: ISODate("2024-01-01T01:00:00Z")  // TTL
}
```

**Reference Document:**
```javascript
{
  _id: "r:user:1",
  keys: ["user:1", "posts:user:1", "comments:user:1"],
  createdAt: ISODate("2024-01-01T00:00:00Z"),
  expireAt: ISODate("2024-01-01T01:00:00Z")  // TTL
}
```

### TTL Management

MongoDB's native TTL indexes handle automatic expiration:
- An index on `expireAt` field is created automatically
- MongoDB removes expired documents in the background
- TTL resolution is approximately 60 seconds

### Key Hashing

Keys longer than 200 characters are automatically hashed using SHA-256:
- Short keys (≤200 chars): stored as-is for readability
- Long keys (>200 chars): hashed to 64-character hex string
- Hashing is transparent to the user

### Reference-Based Invalidation

References create a many-to-one mapping:
1. Multiple cache entries can share the same reference
2. Invalidating a reference removes all associated cache entries
3. Supports exact match and wildcard patterns

**Example:**
```javascript
// Cache entries with references
await storage.set('user-profile:1', profile, 60, ['user:1'])
await storage.set('user-posts:1', posts, 60, ['user:1'])
await storage.set('user-comments:1', comments, 60, ['user:1'])

// Invalidate all at once
await storage.invalidate('user:1')
// All three entries are now removed
```

## Testing

### Unit Tests

```bash
npm run test:unit
```

### Integration Tests

Integration tests require a running MongoDB instance.

**Using Docker:**

```bash
# Start MongoDB
bash scripts/setup-mongodb.sh

# Run integration tests
npm run test:integration

# Stop MongoDB
docker-compose down
```

**Using existing MongoDB:**

```bash
# Set environment variables
export MONGODB_URL=mongodb://localhost:27017
export MONGODB_DATABASE=test
export MONGODB_COLLECTION=cache

# Run tests
npm run test:integration
```

### All Tests

```bash
npm test
```

## Requirements

- Node.js >= 16
- MongoDB >= 4.0 (for TTL index support)
- `mongodb` peer dependency >= 6.0.0

## Comparison with Other Adapters

| Feature | mongo-cache-dedupe | couchbase-cache-dedupe | Redis |
|---------|-------------------|------------------------|-------|
| TTL Support | Native (TTL indexes) | Native | Native |
| Wildcard Invalidation | Regex queries | N1QL queries | Pattern matching |
| Automatic Expiration | Background task (~60s resolution) | Immediate | Immediate |
| Key Hashing | Automatic >200 chars | Automatic >200 chars | Manual |
| Transaction Support | Yes (MongoDB 4.0+) | Yes | Yes (Redis 6.0+) |

## Performance Considerations

1. **TTL Resolution**: MongoDB's TTL monitor runs approximately every 60 seconds. Expired documents may persist for up to 60 seconds after expiration.

2. **Wildcard Invalidation**: Uses regex queries which scan the collection. Consider creating indexes if using complex patterns frequently.

3. **Indexes**: The TTL index is created automatically. For heavy read workloads, consider additional indexes on frequently queried fields.

4. **Batch Operations**: For bulk invalidations, use wildcard patterns instead of multiple single invalidations.

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Credits

Inspired by [couchbase-cache-dedupe](https://github.com/mcollina/couchbase-cache-dedupe) and designed for use with [async-cache-dedupe](https://github.com/mcollina/async-cache-dedupe).
