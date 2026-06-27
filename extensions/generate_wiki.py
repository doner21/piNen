#!/usr/bin/env python3
"""
generate_wiki.py v2.1 — Dual-Audience Wiki Generator (Windows-safe)

Reads graphify-out/graph.json + GRAPH_REPORT.md and generates
a human-readable + LLM-optimized wiki at graphify-out/wiki/.

Usage:
    python generate_wiki.py                          # from project root
    python generate_wiki.py /path/to/graphify-out/   # explicit path
"""

import json
import os
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

# ── Windows cp1252 unicode safety ─────────────────────────────────
def safe_print(text):
    """Print text, replacing unicode chars that cp1252 can't handle."""
    try:
        print(text)
    except UnicodeEncodeError:
        safe = text.encode(sys.stdout.encoding or 'cp1252', errors='replace').decode(sys.stdout.encoding or 'cp1252')
        print(safe)


def short_label(text, maxlen=55):
    return text[:maxlen-3] + '...' if len(text) > maxlen else text


def cohesion_description(c):
    if c < 0.15: return 'loosely connected'
    if c < 0.30: return 'moderately connected'
    if c < 0.50: return 'coherent and well-connected'
    return 'very tightly integrated'


# ── Load data ───────────────────────────────────────────────────────

def load_data(graph_dir):
    graph_dir = Path(graph_dir)
    graph_path = graph_dir / 'graph.json'
    report_path = graph_dir / 'GRAPH_REPORT.md'

    # Also check parent if graph.json is not directly in graph_dir
    if not graph_path.exists():
        # Try common locations
        for candidate in [
            graph_dir / 'graphify-out' / 'graph.json',
            graph_dir.parent / 'graph.json',
            Path.cwd() / 'graphify-out' / 'graph.json',
        ]:
            if candidate.exists():
                graph_path = candidate
                report_path = candidate.parent / 'GRAPH_REPORT.md'
                break

    if not graph_path.exists():
        safe_print(f"ERROR: graph.json not found. Looked in {graph_dir}")
        safe_print("Run from project root with graphify-out/ or pass explicit path.")
        sys.exit(1)
    if not report_path.exists():
        report_path = graph_path.parent / 'GRAPH_REPORT.md'
        if not report_path.exists():
            safe_print(f"ERROR: GRAPH_REPORT.md not found next to graph.json")
            sys.exit(1)

    with open(graph_path, 'r', encoding='utf-8') as f:
        graph = json.load(f)
    with open(report_path, 'r', encoding='utf-8') as f:
        report = f.read()

    safe_print(f"Loaded graph: {len(graph.get('nodes', []))} nodes from {graph_path}")
    return graph, report, graph_path.parent


def parse_report(report):
    parsed = {}
    # Use \u00b7 (middle dot) and \u2013 (en dash) which are in cp1252
    m = re.search(r'(\d+)\s+nodes?\s*[\u00b7\u2022\-]\s*(\d+)\s+edges?\s*[\u00b7\u2022\-]\s*(\d+)\s+communities?', report)
    if m:
        parsed['total_nodes'] = int(m.group(1))
        parsed['total_edges'] = int(m.group(2))
        parsed['total_communities'] = int(m.group(3))
    else:
        parsed['total_nodes'] = 0
        parsed['total_edges'] = 0
        parsed['total_communities'] = 0

    # God nodes
    gods = []
    god_section = re.search(r'## God Nodes.*?(?=\n##)', report, re.DOTALL)
    if god_section:
        for line in god_section.group(0).split('\n'):
            m2 = re.match(r'\d+\.\s+`(.+?)`\s*-?\s*(\d+)\s*edges?', line)
            if m2:
                gods.append({'label': m2.group(1).strip(), 'degree': int(m2.group(2))})
    parsed['gods'] = gods

    # Community labels from report
    labels = {}
    for m in re.finditer(r'### Community (\d+)\s*[-:]+\s*"?([^"\n]+?)"?\s*$', report, re.MULTILINE):
        labels[int(m.group(1))] = m.group(2).strip()
    parsed['report_labels'] = labels

    # Surprising connections
    surps = []
    surp_section = re.search(r'## Surprising Connections.*?(?=\n##)', report, re.DOTALL)
    if surp_section:
        for line in surp_section.group(0).split('\n'):
            m2 = re.match(r'-\s*`(.+?)`\s*[-=]{2,}>?\s*`(.+?)`\s*\[(\w+)\]', line)
            if m2:
                surps.append({'src': m2.group(1), 'tgt': m2.group(2), 'conf': m2.group(3)})
    parsed['surprising'] = surps

    # Knowledge gaps
    gaps = re.search(r'## Knowledge Gaps.*?(?=\n##)', report, re.DOTALL)
    if gaps:
        m2 = re.search(r'\*\*(\d+)\s+isolated', gaps.group(0))
        if m2:
            parsed['isolated_count'] = int(m2.group(1))

    return parsed


# ── Community Analysis ──────────────────────────────────────────────

def analyze_community(cid, members, graph, node_labels, degree_map):
    analysis = {
        'cid': cid,
        'size': len(members),
        'types': Counter(n.get('file_type', '') for n in members),
        'source_files': Counter(n.get('source_file', '') for n in members),
        'top_by_degree': [],
    }

    scored = [(degree_map.get(n['id'], 0), node_labels.get(n['id'], n.get('label', n['id'])), n.get('file_type', '')) for n in members]
    scored.sort(reverse=True)
    analysis['top_by_degree'] = [{'label': l, 'degree': d, 'type': t} for d, l, t in scored[:10]]

    files = analysis['source_files']
    if files:
        top_file = files.most_common(1)[0][0]
        analysis['primary_file'] = Path(top_file).name if top_file else 'unknown'
        analysis['primary_file_count'] = files.most_common(1)[0][1]
    else:
        analysis['primary_file'] = 'unknown'
        analysis['primary_file_count'] = 0

    concepts = [n.get('label', '') for n in members if n.get('file_type') in ('rationale', 'document', 'paper')]
    analysis['concepts'] = concepts[:15]

    type_ratio = analysis['types'].get('code', 0) / max(len(members), 1)
    if type_ratio > 0.7:
        analysis['character'] = 'code'
    elif type_ratio > 0.3:
        analysis['character'] = 'mixed'
    else:
        analysis['character'] = 'concept'

    return analysis


def auto_label(analysis):
    c = analysis['character']
    pf = analysis['primary_file']

    if c == 'code':
        name = pf.replace('.ts','').replace('.js','').replace('.py','').replace('.go','').replace('.rs','')
        return f'{name} Module ({analysis["size"]} functions)'
    elif c == 'concept':
        top = analysis['concepts'][:3]
        if top:
            return f'Domain: {top[0][:40]}'
        return f'Concept Group ({analysis["size"]} nodes)'
    else:
        code_count = analysis['types'].get('code', 0)
        concept_count = analysis['types'].get('rationale', 0) + analysis['types'].get('document', 0)
        return f'{pf.replace(".ts","").replace(".py","")} ({code_count} functions + {concept_count} concepts)'


def write_human_paragraph(analysis):
    c = analysis['character']
    size = analysis['size']
    types = analysis['types']
    top = analysis['top_by_degree']
    concepts = analysis['concepts']

    lines = []
    if c == 'code':
        lines.append(f'This community contains **{size} functions** primarily in **{analysis["primary_file"]}**.')
        if top:
            lines.append('')
            lines.append(f'The most connected function is **{top[0]["label"]}** with {top[0]["degree"]} connections.')
    elif c == 'concept':
        lines.append(f'This community contains **{size} concepts** around a shared theme.')
        if concepts:
            lines.append('')
            lines.append('Key ideas include:')
            for cpt in concepts[:8]:
                lines.append(f'- {cpt}')
    else:
        code_n = types.get('code', 0)
        concept_n = types.get('rationale', 0) + types.get('document', 0)
        lines.append(f'This community blends **{code_n} implementation functions** with **{concept_n} design concepts**.')
        if concepts:
            lines.append(f'The concepts include **{concepts[0][:50]}**.')
    return '\n'.join(lines)


def write_llm_section(cross_edges, all_com_labels):
    lines = []
    if cross_edges:
        lines.append('')
        lines.append('### Cross-Community Connections')
        for tgt, edges in sorted(cross_edges.items(), key=lambda x: len(x[1]), reverse=True):
            tgt_label = all_com_labels.get(tgt, f'Community {tgt}')
            lines.append(f'- **{tgt_label}** (C{tgt}) -- {len(edges)} edge(s)')
            for e in edges[:2]:
                lines.append(f'  - {e["src"]} -> {e["tgt"]} ({e["rel"]})')
    else:
        lines.append('')
        lines.append('**No cross-community edges -- this community is self-contained.**')
    return '\n'.join(lines)


def build_cross_edges(graph):
    node_com = {}
    for n in graph.get('nodes', []):
        c = n.get('community')
        if c is not None:
            node_com[n['id']] = int(c)

    node_labels = {}
    for n in graph.get('nodes', []):
        node_labels[n['id']] = n.get('label', n['id'])

    cross = defaultdict(lambda: defaultdict(list))
    for e in graph.get('links', graph.get('edges', [])):
        s, t = e.get('source', ''), e.get('target', '')
        sc, tc = node_com.get(s), node_com.get(t)
        if sc is not None and tc is not None and sc != tc:
            cross[sc][tc].append({
                'src': node_labels.get(s, s),
                'tgt': node_labels.get(t, t),
                'rel': e.get('relation', '')
            })
    return cross, node_labels


# ── Main Generation ────────────────────────────────────────────────

def main():
    if len(sys.argv) > 1:
        graph_dir = Path(sys.argv[1])
    else:
        cwd = Path.cwd()
        if (cwd / 'graph.json').exists():
            graph_dir = cwd
        elif (cwd / 'graphify-out' / 'graph.json').exists():
            graph_dir = cwd / 'graphify-out'
        else:
            safe_print("ERROR: Could not find graphify-out/ or graph.json.")
            safe_print("Run from project root with graphify-out/ or pass explicit path.")
            sys.exit(1)

    safe_print(f'Generating wiki from: {graph_dir.resolve()}')
    graph, report, gd = load_data(graph_dir)

    # Fix any utf-8 files opened in cp1252
    gd = Path(gd)

    parsed = parse_report(report)

    # Build degree map
    degree_map = Counter()
    links = graph.get('links', graph.get('edges', []))
    for e in links:
        for key in ('source', 'target'):
            v = e.get(key)
            if v:
                degree_map[v] += 1

    # Node labels
    node_labels = {n['id']: n.get('label', n['id']) for n in graph.get('nodes', [])}

    # Group members by community
    com_members = defaultdict(list)
    for n in graph.get('nodes', []):
        c = n.get('community')
        if c is not None:
            com_members[int(c)].append(n)

    if not com_members:
        safe_print("WARNING: No communities found in graph data. Did graphify run clustering?")
        safe_print("Assigning all nodes to Community 0 for wiki generation.")
        com_members[0] = graph.get('nodes', [])

    # Analyze each community
    com_analyses = {}
    all_labels = {}
    for cid, members in com_members.items():
        analysis = analyze_community(cid, members, graph, node_labels, degree_map)
        com_analyses[cid] = analysis
        report_label = parsed.get('report_labels', {}).get(cid)
        if report_label and report_label != f'Community {cid}':
            all_labels[cid] = report_label
        else:
            all_labels[cid] = auto_label(analysis)

    # Build cross-community edges
    cross_edges, _ = build_cross_edges(graph)

    # Get cohesion from report
    cohesion_map = {}
    for match in re.finditer(r'### Community (\d+).*?\nCohesion: ([\d.]+)', report):
        cohesion_map[int(match.group(1))] = float(match.group(2))

    # === Generate wiki pages ===
    wiki_dir = gd / 'wiki'
    wiki_dir.mkdir(parents=True, exist_ok=True)

    sorted_coms = sorted(com_analyses.items(), key=lambda x: x[1]['size'], reverse=True)[:20]

    # --- _INDEX.md ---
    lines = [
        '---',
        'type: wiki/index',
        'generated: auto',
        f'nodes: {parsed.get("total_nodes", "?")}',
        f'edges: {parsed.get("total_edges", "?")}',
        f'communities: {parsed.get("total_communities", "?")}',
        '---',
        '',
        '# Project Knowledge Graph Wiki',
        '',
        '> Auto-generated from graphify knowledge graph data.',
        '> Each page has narrative for humans and structured data for LLMs.',
        '',
        '## Contents',
        '',
        '| Section | Description |',
        '|---------|-------------|',
        '| [[01_OVERVIEW/_README|Overview]] | What this graph represents |',
        '| [[01_OVERVIEW/ARCHITECTURE_AT_A_GLANCE|Architecture at a Glance]] | The big picture |',
        '| [[01_OVERVIEW/GLOSSARY|Glossary]] | Key concepts explained |',
        f'| [[02_TOP_COMMUNITIES/_README|Top Communities]] | Top {len(sorted_coms)} neighborhoods |',
        '',
        '## Quick Stats',
        '',
        f'- **{parsed.get("total_nodes", "?")}** concepts (nodes)',
        f'- **{parsed.get("total_edges", "?")}** relationships (edges)',
        f'- **{parsed.get("total_communities", "?")}** communities',
    ]
    gods = parsed.get('gods', [])
    if gods:
        lines.extend(['', '## Most Connected Concepts (God Nodes)', '', 'The hubs everything connects through:', ''])
        for g in gods[:10]:
            lines.append(f'- **{g["label"]}** -- {g["degree"]} connections')
    surps = parsed.get('surprising', [])
    if surps:
        lines.extend(['', '## Surprising Connections', ''])
        for s in surps[:5]:
            lines.append(f'- {s["src"]} -> {s["tgt"]} ({s["conf"]})')

    isolated = parsed.get('isolated_count', 0)
    if isolated > 0:
        lines.extend(['', '## Knowledge Gaps', '', f'- **{isolated} weakly-connected nodes** -- may be undocumented or isolated.'])

    (wiki_dir / '_INDEX.md').write_text('\n'.join(lines), encoding='utf-8')
    safe_print(f'  [OK] _INDEX.md')

    # --- 01_OVERVIEW/ ---
    od = wiki_dir / '01_OVERVIEW'
    od.mkdir(parents=True, exist_ok=True)

    lines = [
        '---',
        'type: overview',
        '---',
        '',
        '# What This Graph Represents',
        '',
        '## In Plain Language',
        '',
        f'This knowledge graph is a **map of how concepts connect** in this project. It has **{parsed.get("total_nodes", "?")} concepts** organized into **{parsed.get("total_communities", "?")} neighborhoods** (communities).',
        '',
        f'1. Browse the [[../02_TOP_COMMUNITIES/_README|Top Communities]] -- pick one that interests you',
        '2. Read its "For Humans" section with plain-language explanation',
        '3. Check its "For LLMs" section for structured data about connections and structure',
    ]
    (od / '_README.md').write_text('\n'.join(lines), encoding='utf-8')
    safe_print(f'  [OK] 01_OVERVIEW/_README.md')

    # ARCHITECTURE_AT_A_GLANCE.md
    lines = [
        '---',
        'type: overview/architecture',
        '---',
        '',
        '# Architecture at a Glance',
        '',
    ]
    if gods:
        lines.extend(['## Core Concepts (God Nodes)', '', 'The most connected concepts form the backbone:', ''])
        for g in gods[:12]:
            lines.append(f'- **{g["label"]}** ({g["degree"]} connections)')
    lines.extend(['', '## Community Map', '', '| # | Community | Nodes | Character |', '|---|-----------|-------|-----------|'])
    for cid, analysis in sorted_coms:
        label = all_labels.get(cid, f'Community {cid}')
        lines.append(f'| {cid} | [[../02_TOP_COMMUNITIES/COMMUNITY_{cid}|{short_label(label, 45)}]] | {analysis["size"]} | {analysis["character"]} |')
    (od / 'ARCHITECTURE_AT_A_GLANCE.md').write_text('\n'.join(lines), encoding='utf-8')
    safe_print(f'  [OK] 01_OVERVIEW/ARCHITECTURE_AT_A_GLANCE.md')

    # GLOSSARY.md
    lines = [
        '---',
        'type: reference/glossary',
        '---',
        '',
        '# Glossary',
        '',
        '## Edge Types',
        '',
        '| Type | Certainty | Meaning |',
        '|------|-----------|---------|',
        '| EXTRACTED | 1.0 | Found directly in source code or documents |',
        '| INFERRED | 0.6-0.9 | Reasonable guess by the AI |',
        '| AMBIGUOUS | 0.1-0.3 | Needs human verification |',
        '',
        '**Node** -- A single concept (file, function, idea) with a label, type, and source location.',
        '**Edge** -- A relationship between two nodes, tagged with confidence.',
        '**Community** -- A group of nodes more connected to each other than the rest of the graph.',
        '**God Node** -- The most connected node(s) in the graph.',
        '**Cohesion** -- A score (0-1) measuring how tightly connected a community is.',
        '',
    ]
    if gods:
        lines.extend(['## Key Concepts in This Project', '', '| Concept | Connections |', '|---------|-----------|'])
        for g in gods[:15]:
            lines.append(f'| {g["label"]} | {g["degree"]} |')
    (od / 'GLOSSARY.md').write_text('\n'.join(lines), encoding='utf-8')
    safe_print(f'  [OK] 01_OVERVIEW/GLOSSARY.md')

    # --- 02_TOP_COMMUNITIES/ ---
    cd = wiki_dir / '02_TOP_COMMUNITIES'
    cd.mkdir(parents=True, exist_ok=True)

    lines = [
        '---',
        'type: community/index',
        '---',
        '',
        '# Top Communities',
        '',
        f'> Top {len(sorted_coms)} communities by size.',
        '',
        '| # | Community | Nodes | Character | Cohesion | Key Concepts |',
        '|---|-----------|-------|-----------|----------|-------------|',
    ]
    for cid, analysis in sorted_coms:
        label = all_labels.get(cid, f'Community {cid}')
        coh = cohesion_map.get(cid, 0)
        samples = [s['label'] for s in analysis['top_by_degree'][:4]]
        lines.append(f'| {cid} | [[COMMUNITY_{cid}|{short_label(label, 45)}]] | {analysis["size"]} | {analysis["character"]} | {coh:.2f} | {", ".join(short_label(s,30) for s in samples)} |')
    lines.extend(['', '---', '', '**Cohesion guide:** 0.0-0.15 loose / 0.15-0.30 moderate / 0.30-0.50 coherent / 0.50+ tight'])
    (cd / '_README.md').write_text('\n'.join(lines), encoding='utf-8')
    safe_print(f'  [OK] 02_TOP_COMMUNITIES/_README.md')

    for cid, analysis in sorted_coms:
        label = all_labels.get(cid, f'Community {cid}')
        size = analysis['size']
        coh = cohesion_map.get(cid, 0)
        char = analysis['character']
        top = analysis['top_by_degree']
        human_text = write_human_paragraph(analysis)
        llm_cross = write_llm_section(cross_edges.get(cid, {}), all_labels)

        lines = [
            '---',
            f'type: community/narrative',
            f'community_id: {cid}',
            f'label: "{label}"',
            f'size: {size}',
            f'cohesion: {coh:.2f}',
            f'character: {char}',
            '---',
            '',
            f'# Community {cid}: {label}',
            '',
            f'> **{size} nodes** | **Cohesion: {coh:.2f}** ({cohesion_description(coh)}) | **Character: {char}**',
            '',
            '## For Humans',
            '',
            human_text,
            '',
            '## For LLMs',
            '',
            '### Data',
            '',
            f'- **ID:** {cid}',
            f'- **Label:** {label}',
            f'- **Size:** {size} nodes',
            f'- **Cohesion:** {coh:.2f}',
            f'- **Character:** {char}',
            f'- **Primary file:** {analysis["primary_file"]}',
            '',
            '### Top Nodes by Connectivity',
            '',
        ]
        for t in top[:10]:
            lines.append(f'- **{t["label"]}** -- {t["degree"]} connections [{t["type"]}]')
        lines.append(llm_cross)
        lines.append('')

        (cd / f'COMMUNITY_{cid}.md').write_text('\n'.join(lines), encoding='utf-8')

    safe_print(f'  [OK] {len(sorted_coms)} community narratives')

    (wiki_dir / '_WIKI.md').write_text('---\ntype: pointer\n---\n\n# Wiki\n\nStart at `_INDEX.md`.\n', encoding='utf-8')

    page_count = len(list(wiki_dir.rglob('*.md')))
    safe_print(f'\n[DONE] Wiki generated: {wiki_dir} ({page_count} pages)')
    safe_print('Open wiki/_INDEX.md to browse.')


if __name__ == '__main__':
    main()
