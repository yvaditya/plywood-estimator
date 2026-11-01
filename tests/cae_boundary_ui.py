"""Production browser checks for boundary-conforming shell and solid meshes."""
import json
import re
import subprocess
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parent.parent
out = root / 'tests' / '_output' / 'cae_boundary_ui'
out.mkdir(parents=True, exist_ok=True)
subprocess.run(['node', '--input-type=module', '-e', '''
import {build} from './app/node_modules/esbuild/lib/main.js';
import {writeFileSync} from 'node:fs';
await build({entryPoints:['app/src/stepExport.ts'],outfile:'tests/_output/cae_boundary_ui/exporter.mjs',bundle:true,format:'esm',platform:'node',logLevel:'silent'});
const {buildAssemblyStep}=await import('./tests/_output/cae_boundary_ui/exporter.mjs');
const rectangle=(w,h)=>[[0,0],[w,0],[w,h],[0,h]];
const side=x=>({name:'Side',outer:rectangle(120,100),holes:[],thickness:10,origin:[x,0,0],uAxis:[0,1,0],vAxis:[0,0,1],normal:[1,0,0]});
const top={name:'Top with hole',outer:rectangle(200,120),holes:[[[77,40],[77,80],[113,80],[113,40]]],thickness:10,origin:[0,0,100],uAxis:[1,0,0],vAxis:[0,1,0],normal:[0,0,1]};
writeFileSync('tests/_output/cae_boundary_ui/cabinet.step',buildAssemblyStep([side(0),side(190),top],new Date().toISOString(),'Mesh boundary cabinet'));
'''], cwd=root, check=True)

def counts(text):
    kind = re.search(r'([\d,]+)\s+(quad|hex)', text)
    nodes = re.search(r'([\d,]+)\s+nodes', text)
    dof = re.search(r'([\d,]+)\s+DOF', text)
    return {'elements': int(kind[1].replace(',', '')), 'kind': kind[2], 'nodes': int(nodes[1].replace(',', '')), 'dof': int(dof[1].replace(',', ''))}

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width':1500, 'height':1000})
    errors = []
    solve_logs = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('console', lambda message: solve_logs.append(message.text) if message.text.startswith('[assembly]') else None)
    if len(sys.argv)>2:
        page.add_init_script('globalThis.__pyniteBase = '+json.dumps(sys.argv[2]))
    page.goto(sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:5184', wait_until='networkidle')
    page.set_input_files('#fileInput', str(out/'cabinet.step'))
    expect(page.locator('#bodyCount')).to_have_text('3', timeout=60000)
    page.locator('#modeAnalysisBtn').click()
    page.locator('#asmDetectBtn').click()
    stats = page.locator('#asmMeshStats')
    expect(page.locator('#asmMeshView')).to_have_value('surface')
    expect(page.locator('#asmDeformScale')).to_have_value('0')
    expect(stats).to_contain_text('CAD boundaries: conforming', timeout=20000)
    expect(stats).to_contain_text('area mismatch 0.00 mm²')
    expect(stats).to_contain_text('Worst element aspect ratio')
    expect(stats).to_contain_text('approximate node links')
    shell = counts(stats.inner_text())
    assert shell['dof'] == shell['nodes']*6
    page.select_option('#asmMeshDensity', '20')
    finer = counts(stats.inner_text())
    assert finer['nodes'] > shell['nodes']
    page.locator('#asmShowNodes').check()
    page.screenshot(path=str(out/'shell-with-hole.png'), full_page=True)
    page.locator('#asmShowNodes').uncheck()
    page.select_option('#asmMeshKind', 'solid')
    expect(stats).to_contain_text('hex')
    solid = counts(stats.inner_text())
    assert solid['dof'] == solid['nodes']*3
    page.select_option('#asmSolidLayers', '3')
    expect(stats).to_contain_text('3 layers')
    three = counts(stats.inner_text())
    assert three['nodes'] > solid['nodes']
    page.select_option('#asmMeshView', 'wire')
    page.screenshot(path=str(out/'solid-with-hole.png'), full_page=True)
    page.select_option('#asmMeshView', 'surface')
    page.wait_for_timeout(250)
    page.screenshot(path=str(out/'solid-surface.png'), full_page=True)
    page.select_option('#asmMeshView', 'wire')
    page.locator('#asmShowNodes').check()
    page.wait_for_timeout(250)
    page.screenshot(path=str(out/'solid-volume-nodes.png'), full_page=True)
    assert counts(stats.inner_text()) == three, 'View controls must not rebuild the solver mesh'
    page.locator('#asmPreset50').click()
    page.locator('#asmSolveBtn').click()
    page.wait_for_function("() => !document.querySelector('#asmSolveBtn').disabled && !document.querySelector('#asmFieldToggle').hidden", timeout=60000)
    solid_solved = counts(stats.inner_text())
    expect(page.locator('#asmDeformScale')).to_have_value('0')
    page.select_option('#asmDeformScale', 'auto')
    page.wait_for_timeout(250)
    page.screenshot(path=str(out/'solid-deformed.png'), full_page=True)
    page.select_option('#asmDeformScale', '0')
    assert counts(stats.inner_text()) == three
    assert solid_solved == three, 'Solid solving must retain H8 elements and the preview mesh'
    page.select_option('#asmMeshKind', 'shell')
    page.locator('#asmSolveBtn').click()
    page.wait_for_function("() => !document.querySelector('#asmSolveBtn').disabled && !document.querySelector('#asmFieldToggle').hidden", timeout=60000)
    expect(stats).to_contain_text('CAD boundaries: conforming')
    solved = counts(stats.inner_text())
    assert solved == finer, 'The solved mesh must match its preview'
    page.screenshot(path=str(out/'solved.png'), full_page=True)
    assert not errors, errors
    (out/'summary.json').write_text(json.dumps({'shell':shell,'finer':finer,'solid':solid,'threeLayers':three,'solidSolved':solid_solved,'solved':solved,'solveLogs':solve_logs,'browserErrors':errors},indent=2), encoding='utf-8')
    browser.close()
    print('PASS: shell/H8 hole mesh, actual DOF, quality report, approximate joint disclosure, refinement, thickness layers, preview/solve mesh identity, no browser errors')
