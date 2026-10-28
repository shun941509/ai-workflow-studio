"""Bounded directed graph exploration over explicit authorized entities and sourced edges only."""
from collections import deque
from contracts import main, fail, text, identifier, integer, source_span


def run(data):
    question=text(data.get('question'),'question',8000); start=identifier(data.get('start'),'start'); target=identifier(data.get('target'),'target')
    entities=data.get('entityIds'); allowed_entities=data.get('allowedEntityIds'); allowed_documents=data.get('allowedDocumentIds'); edges=data.get('edges')
    if not isinstance(entities,list) or not isinstance(allowed_entities,list) or not isinstance(allowed_documents,list) or not isinstance(edges,list) or len(edges)>5000: fail('GRAPH_CONTRACT','Explicit graph inventory and current allowlists are required.')
    nodes=set(identifier(value,'entityId') for value in entities); allowed=set(identifier(value,'allowedEntityId') for value in allowed_entities); documents=set(identifier(value,'allowedDocumentId') for value in allowed_documents)
    if not allowed<=nodes or start not in allowed or target not in allowed: fail('ENTITY_ACCESS','Both endpoint IDs must be in the trusted allowed graph inventory.')
    maximum=integer(data.get('maxDepth'),1,5,'maxDepth'); visited_limit=integer(data.get('maxExpansions'),1,10000,'maxExpansions'); path_limit=integer(data.get('maxPaths'),1,100,'maxPaths')
    outgoing={}; ids=set(); omitted=0
    for edge in edges:
        identity=identifier(edge.get('id'),'edge.id'); left=identifier(edge.get('from'),'from'); right=identifier(edge.get('to'),'to')
        if identity in ids or left not in nodes or right not in nodes: fail('EDGE_CONTRACT','Edges require unique IDs and existing endpoints.')
        ids.add(identity); quote,source=source_span(edge.get('source'),edge.get('quote'))
        if left not in allowed or right not in allowed or source['documentId'] not in documents: omitted+=1; continue
        outgoing.setdefault(left,[]).append({'id':identity,'from':left,'to':right,'quote':quote,'source':source})
    for group in outgoing.values(): group.sort(key=lambda item:item['id'])
    queue=deque([([start],[])]); paths=[]; expansions=0; truncated=False
    while queue:
        if expansions>=visited_limit or len(paths)>=path_limit: truncated=True; break
        route,proof=queue.popleft(); expansions+=1
        if route[-1]==target:
            paths.append({'entities':route,'edges':proof}); continue
        if len(proof)>=maximum: continue
        for edge in outgoing.get(route[-1],[]):
            if edge['to'] not in route: queue.append((route+[edge['to']],proof+[edge]))
            if len(queue)>visited_limit: truncated=True; break
        if truncated: break
    return {'question':question,'paths':paths,'expansions':expansions,'truncated':truncated,'omittedUnauthorizedEdges':omitted,'profile':'bounded-directed-bfs-v1','inferredRelations':[],'authorizationVerified':False}


if __name__=='__main__': main(run)
