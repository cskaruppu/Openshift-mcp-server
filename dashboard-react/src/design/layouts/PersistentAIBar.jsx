import { useState, useRef, useCallback } from 'react';
import { useActiveCluster } from '../../store/clusterStore';
import { useViewStore } from '../../store/viewStore';

export function PersistentAIBar() {
  const [query, setQuery] = useState('');
  const cluster = useActiveCluster();
  const setView = useViewStore((s) => s.setActiveView);
  const inputRef = useRef(null);

  const handleSubmit = useCallback((e) => {
    e.preventDefault();
    const text = query.trim();
    if (!text) return;
    window.dispatchEvent(new CustomEvent('ai-bar-query', { detail: { text, cluster } }));
    setView('chat');
    setQuery('');
  }, [query, cluster, setView]);

  return (
    <div className="ds-ai-bar">
      <form className="ds-ai-bar-form" onSubmit={handleSubmit}>
        <span className="ds-ai-bar-icon">💬</span>
        <input
          ref={inputRef}
          className="ds-ai-bar-input"
          placeholder={`Ask anything about your cluster...`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="ds-ai-bar-send" type="submit" disabled={!query.trim()}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
        </button>
      </form>
    </div>
  );
}
