"""Validate directional typed relation proposals and report alias collisions without automatic merges."""
from contracts import main, fail, text, identifier, source_span


def run(data):
    entities=data.get('entities'); relations=data.get('relations'); types=data.get('relationTypes')
    if not isinstance(entities,list) or not 1<=len(entities)<=1000 or not isinstance(relations,list) or len(relations)>2000 or not isinstance(types,dict): fail('GRAPH_CONTRACT','Declare bounded entities, relation proposals, and directional type rules.')
    inventory={}; names={}
    for entity in entities:
        identity=identifier(entity.get('id'),'entity.id'); kind=identifier(entity.get('type'),'entity.type'); aliases=entity.get('names')
        if identity in inventory or not isinstance(aliases,list) or not aliases: fail('ENTITY_CONTRACT','Each entity requires a unique ID and explicit names.')
        aliases=list(dict.fromkeys(text(value,'entity.name',200) for value in aliases)); inventory[identity]={'type':kind,'names':aliases}
        for name in aliases: names.setdefault(name,[]).append(identity)
    conflicts=[{'alias':name,'entityIds':sorted(ids),'action':'review_without_merge'} for name,ids in sorted(names.items()) if len(ids)>1]
    seen=set(); output=[]
    for relation in relations:
        identity=identifier(relation.get('id'),'relation.id'); kind=identifier(relation.get('type'),'relation.type'); left=identifier(relation.get('from'),'from'); right=identifier(relation.get('to'),'to')
        if identity in seen or left==right or left not in inventory or right not in inventory or kind not in types: fail('RELATION_CONTRACT','Relation identity, endpoints, or type are invalid.')
        rule=types[kind]
        if not isinstance(rule,dict) or not isinstance(rule.get('fromTypes'),list) or not isinstance(rule.get('toTypes'),list): fail('TYPE_RULE','A directional fromTypes/toTypes contract is required.')
        if inventory[left]['type'] not in rule['fromTypes'] or inventory[right]['type'] not in rule['toTypes']: fail('DIRECTION_TYPE_MISMATCH','Relation endpoints violate the declared direction/type contract.')
        quote,source=source_span(relation.get('source'),relation.get('quote'))
        if not any(name in quote for name in inventory[left]['names']) or not any(name in quote for name in inventory[right]['names']): fail('ENDPOINT_EVIDENCE_MISSING','The relation quote does not contain both declared endpoint names.')
        seen.add(identity); output.append({'id':identity,'type':kind,'from':left,'to':right,'quote':quote,'source':source,'reviewRequired':True})
    return {'relationCandidates':output,'aliasConflicts':conflicts,'mergedEntities':[],'graphWritten':False,'semanticDirectionVerified':False}


if __name__=='__main__': main(run)
