import asyncio
import pprint
from motor.motor_asyncio import AsyncIOMotorClient

async def main():
    client = AsyncIOMotorClient('mongodb://miranda:Mirandam2@187.124.232.150:27017/mos-system')
    db = client['mos-system']
    doc = await db.invoices.find_one({'invoice_id': 'M-20'}, {'items': 1, 'print_location': 1})
    pprint.pprint(doc)

if __name__ == '__main__':
    asyncio.run(main())
