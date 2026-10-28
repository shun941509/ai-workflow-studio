"""Prepare deterministic graph-component summaries and trace supplied summaries back to sourced edges."""
from contracts import main, fail, text, identifier, source_span


def run(data):
    question=text(data.get('question'),'question',8000); nodes=data.get('entityIds'); edges=data.get('edges'); operation=data.get('operation','prepare')
    if not isinstance(nodes,list) or not 1<=len(nodes)<=1000 or not isinstance(edges,list) or len(edges)>5000 or operation not in ['prepare','assemble']: fail('GRAPH_CONTRACT','Provide a bounded already-authorized graph and prepare/assemble operation.')
    nodes=[identifier(value,'entityId') for value in nodes]
    if len(set(nodes))!=len(nodes): fail('DUPLICATE_ID','Entity IDs must be unique.')
    adjacent={node:set() for node in nodes}; inventory={}
    for edge in edges:
        identity=identifier(edge.get('id'),'edge.id'); left=identifier(edge.get('from'),'from'); right=identifier(edge.get('to'),'to')
        if identity in inventory or left not in adjacent or right not in adjacent: fail('EDGE_CONTRACT','Every edge needs unique identity and existing endpoints.')
        quote,source=source_span(edge.get('source'),edge.get('quote')); inventory[identity]={'id':identity,'from':left,'to':right,'quote':quote,'source':source}
        adjacent[left].add(right); adjacent[right].add(left)
    # Connected components are an explicitly limited, deterministic grouping profile, not Louvain.
    visited=set(); communities=[]
    for node in sorted(nodes):
        if node in visited: continue
        pending=[node]; members=[]; visited.add(node)
        while pending:
            item=pending.pop(); members.append(item)
            for neighbor in sorted(adjacent[item]):
                if neighbor not in visited: visited.add(neighbor); pending.append(neighbor)
        members.sort(); community_edges=[item for item in inventory.values() if item['from'] in members and item['to'] in members]
        communities.append({'id':'community-'+str(len(communities)+1),'entityIds':members,'edges':sorted(community_edges,key=lambda item:item['id'])})
    hierarchy={'rootId':'global','children':[item['id'] for item in communities]}
    if operation=='prepare': return {'profile':'connected-components-two-level-v1','question':question,'hierarchy':hierarchy,'communities':communities,'summaryContract':{'communityId':'one existing community ID','claims':'[{text,edgeIds}] with exact sourced support; no unsupported claims'},'summaries':None,'modelCalled':False}
    summaries=data.get('summaries'); global_claims=data.get('globalClaims')
    if not isinstance(summaries,list) or not isinstance(global_claims,list): fail('SUMMARIES_REQUIRED','Supply actual reviewed community summaries and global claims.')
    groups={item['id']:item for item in communities}; checked={}
    for summary in summaries:
        identity=identifier(summary.get('communityId'),'communityId'); claims=summary.get('claims')
        if identity not in groups or identity in checked or not isinstance(claims,list): fail('SUMMARY_CONTRACT','Each community needs exactly one actual summary record.')
        allowed={edge['id'] for edge in groups[identity]['edges']}; collected=[]
        for claim in claims:
            value=text(claim.get('text'),'claim.text',8000); references=claim.get('edgeIds')
            if not isinstance(references,list) or not references or any(ref not in allowed for ref in references): fail('SUMMARY_EVIDENCE','Summary must cite actual edges inside its own community.')
            collected.append({'text':value,'evidence':[inventory[ref] for ref in dict.fromkeys(references)]})
        checked[identity]=collected
    if set(checked)!=set(groups): fail('SUMMARY_MISSING','At least one community lacks an explicit summary, including an empty no-evidence record.')
    output=[]
    for claim in global_claims:
        value=text(claim.get('text'),'globalClaim.text',8000); refs=claim.get('references')
        if not isinstance(refs,list) or not refs: fail('GLOBAL_EVIDENCE','Global claims need actual community claim references.')
        proof=[]
        for reference in refs:
            identity=reference.get('communityId'); position=reference.get('claimIndex')
            if identity not in checked or isinstance(position,bool) or not isinstance(position,int) or not 0<=position<len(checked[identity]): fail('GLOBAL_EVIDENCE','Global reference points outside checked community claims.')
            proof.append({'communityId':identity,'claimIndex':position,'claim':checked[identity][position]})
        output.append({'text':value,'references':proof})
    return {'profile':'connected-components-two-level-v1','question':question,'hierarchy':hierarchy,'globalClaims':output,'provenanceChecked':True,'semanticSupportVerified':False,'modelCalled':False}


if __name__=='__main__': main(run)
