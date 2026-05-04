import pymongo
import pprint

def main():
    try:
        # Connecting synchronously to avoid asyncio loop issues
        client = pymongo.MongoClient('mongodb://miranda:Mirandam2@187.124.232.150:27017/mos-system?authSource=admin')
        db = client['mos-system']
        
        # Check M-20
        doc = db.invoices.find_one({'invoice_id': 'M-20'}, {'items': 1, 'print_location': 1})
        print("\n--- DATABASE RECORD FOR M-20 ---")
        pprint.pprint(doc)
        print("--------------------------------\n")
        
    except Exception as e:
        print(f"Error connecting to DB: {e}")

if __name__ == '__main__':
    main()
