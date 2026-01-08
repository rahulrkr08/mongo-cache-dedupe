// MongoDB initialization script
// This script runs when the container first starts

db = db.getSiblingDB('test')

// Create cache collection
db.createCollection('cache')

// Create TTL index for automatic expiration
db.cache.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 })

print('MongoDB initialization complete')
print('Database: test')
print('Collection: cache')
print('TTL index created on expireAt field')
