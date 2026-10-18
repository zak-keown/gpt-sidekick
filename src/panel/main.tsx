import { render } from 'preact';
import { App } from './App';
import './styles.css';

render(<App demo={new URLSearchParams(location.search).has('demo')} />, document.getElementById('app')!);
