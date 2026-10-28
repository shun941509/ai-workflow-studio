"""Extract a reviewed dictionary's entities with exact original evidence; no open-ended model inference."""
import re
from contracts import main, fail, text, identifier, integer, digest


def run(data):
    document = data.get('document', {}); original = text(document.get('text'), 'document.text')
    document_id = identifier(document.get('id'), 'document.id'); revision = integer(document.get('revision'), 1, 1000000, 'revision')
    allowed_types = data.get('allowedTypes'); dictionary = data.get('dictionary')
    if not isinstance(allowed_types,list) or not allowed_types or not isinstance(dictionary,list) or not 1<=len(dictionary)<=1000: fail('DICTIONARY_REQUIRED', 'Provide reviewed entity types and dictionary entries.')
    allowed_types = set(identifier(value,'entity.type') for value in allowed_types); identities=set(); aliases={}; matches=[]
    for entity in dictionary:
        identity=identifier(entity.get('id'),'entity.id'); kind=identifier(entity.get('type'),'entity.type'); names=entity.get('names')
        if identity in identities or kind not in allowed_types or not isinstance(names,list) or not names: fail('ENTITY_CONTRACT','Entity identity/type/names are invalid.')
        identities.add(identity)
        for name in names:
            name=text(name,'entity.name',200)
            if name in aliases and aliases[name]!=identity: fail('AMBIGUOUS_ALIAS','One dictionary alias names multiple entities; review it before extraction.')
            aliases[name]=identity
            for found in re.finditer(re.escape(name),original): matches.append((found.start(),found.end(),identity,kind,name))
    # Longest matching source span wins at an overlapping position; no entity IDs are merged.
    matches.sort(key=lambda item:(item[0],-(item[1]-item[0]),item[2])); selected=[]; cursor=-1
    for start,end,identity,kind,name in matches:
        if start<cursor: continue
        cursor=end; selected.append({'entityId':identity,'type':kind,'surface':name,'source':{'documentId':document_id,'revision':revision,'sha256':digest(original.encode('utf-8')),'encoding':'utf8','start':len(original[:start].encode('utf-8')),'end':len(original[:end].encode('utf-8'))}})
    return {'profile':'reviewed-exact-dictionary-v1','mentions':selected,'entityIds':sorted(set(item['entityId'] for item in selected)),'unlistedEntityDiscovery':False,'modelCalled':False,'dictionaryReviewRequired':True}


if __name__=='__main__': main(run)
