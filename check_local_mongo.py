from pymongo import MongoClient
import sys

try:
    client = MongoClient("mongodb://localhost:27017/", serverSelectionTimeoutMS=2000)
    client.admin.command('ping')
    print("Local MongoDB is UP")
    print("Databases:", client.list_database_names())
except Exception as e:
    print(f"Local MongoDB is DOWN: {e}")
