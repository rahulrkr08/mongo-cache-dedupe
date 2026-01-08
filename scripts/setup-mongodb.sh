#!/bin/bash

# MongoDB setup script for testing
# This script starts MongoDB using Docker Compose and waits for it to be ready

set -e

echo "Starting MongoDB container..."
docker-compose up -d mongodb

echo "Waiting for MongoDB to be ready..."
until docker-compose exec -T mongodb mongosh --eval "db.adminCommand('ping')" > /dev/null 2>&1; do
  echo "  Waiting for MongoDB to accept connections..."
  sleep 2
done

echo "MongoDB is ready!"
echo ""
echo "Connection details:"
echo "  URL: mongodb://localhost:27017"
echo "  Database: test"
echo "  Collection: cache"
echo "  Authentication: None (for testing)"
echo ""
echo "To stop MongoDB:"
echo "  docker-compose down"
echo ""
echo "To stop and remove data:"
echo "  docker-compose down -v"
