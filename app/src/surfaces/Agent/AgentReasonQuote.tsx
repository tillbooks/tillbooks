/**
 * N01 US-N01.8: THE AGENT'S REASON, quoted under a Vorschlag's title. The agent may send one sentence
 * (`agentReason`, at most 500 characters) with a governed write; the engine stores it on the Vorschlag and
 * `list_drafted_actions` returns it. It is the agent's words, so it is quoted (de-CH guillemets, English
 * curly quotes) and never styled as TILL's own statement: dim ink, the text size of the meta line, at most
 * two lines with the whole sentence in the title attribute. A screen reader hears whose words they are.
 * Nothing renders when the agent gave no reason.
 */
import { useI18n } from '../../i18n';
import './AgentReasonQuote.css';

export function AgentReasonQuote({ text }: { text: string | null | undefined }) {
  const { t } = useI18n();
  if (typeof text !== 'string' || text.trim() === '') return null;
  const sentence = text.trim();
  return (
    <span className="vorschlag-line-reason" title={sentence}>
      <span className="visually-hidden">{t('agent.line.agentReasonLabel')}</span>
      {t('agent.line.agentReason', { text: sentence })}
    </span>
  );
}
