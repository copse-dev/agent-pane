import { createDemoApi } from './demo-api.ts'
import { selectDemoScenario } from './scenarios.ts'

const scenario = selectDemoScenario(window.location.search)
window.api = createDemoApi(scenario)
document.documentElement.dataset['demoScenario'] = scenario.id

void import('../main.ts')
