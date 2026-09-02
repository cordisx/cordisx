import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import 'tdesign-react/dist/tdesign.css'
import './styles.css'

const root = document.getElementById('root')
if (root === null) throw new Error('CordisX Playground root is missing')
createRoot(root).render(<App />)
