from pymongo import MongoClient
MONGO_URL = "mongodb://miranda:Mirandam2@187.124.232.150:27017/mos-system?authSource=admin"
client = MongoClient(MONGO_URL)
col = client['mos-system']['wms_inventory']

exists_true = {"$exists": True}
exists_false = {"$exists": False}
r = col.update_many(
    {"inv_location": exists_true, "location": exists_false},
    [{"$set": {"location": "$inv_location"}}, {"$unset": "inv_location"}]
)
print("inv_location renamed:", r.modified_count)

sample = col.find_one({"units_on_hand": {"$gt": 0}}, {"_id": 0, "customer": 1, "style": 1, "units_on_hand": 1, "location": 1})
print("sample:", sample)
client.close()
