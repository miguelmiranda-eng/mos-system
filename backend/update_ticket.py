from pymongo import MongoClient
client = MongoClient('mongodb://miranda:Mirandam2@187.124.232.150:27017/mos-system?authSource=admin')
db = client['mos-system']
db['wms_pick_tickets'].update_one({'ticket_id': 'pick_a5694a939b12'}, {'$set': {'style': '2000'}})
print('Estilo del ticket pick_a5694a939b12 actualizado a 2000')
