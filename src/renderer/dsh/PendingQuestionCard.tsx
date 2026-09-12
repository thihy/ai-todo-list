import {
  Button,
  DisclosureRow,
  IconCloseOutline16,
  Pill,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { UserQuestionRequest } from '../../shared/ai-types';

interface PendingQuestionCardProps {
  questions: UserQuestionRequest['questions'];
  selected: Record<string, string[]>;
  submitting: boolean;
  error: string | null;
  onToggle: (questionId: string, label: string, multi: boolean) => void;
  onSubmit: () => void;
  onSkip: () => void;
}

/** Interactive host adapter for DSH's pending user-question interaction.
 * The upstream AskQuestionCard is a transcript renderer, so the pending form
 * is composed from DSH's public Button, Pill and DisclosureRow primitives. */
export function PendingQuestionCard({
  questions,
  selected,
  submitting,
  error,
  onToggle,
  onSubmit,
  onSkip,
}: PendingQuestionCardProps) {
  const ready = questions.every(
    (question) => question.options?.length
      ? (selected[question.id]?.length ?? 0) > 0
      : true,
  );

  return (
    <div className="aipane__hitl aipane__hitl--question" role="region" aria-label="AI 询问" aria-busy={submitting}>
      <div className="aipane__hitl-head">
        <Pill className="aipane__hitl-pill">需要回答</Pill>
        <span className="aipane__hitl-title">AI 需要你的输入</span>
        <Button
          variant="ghost"
          onClick={onSkip}
          aria-label="跳过问题"
          title="跳过问题"
          disabled={submitting}
        >
          <IconCloseOutline16 size={12} />
        </Button>
      </div>
      <div className="aipane__hitl-body">
        {questions.map((question) => {
          const current = selected[question.id] ?? [];
          const multi = question.multiSelect ?? false;
          return (
            <DisclosureRow
              key={question.id}
              icon={<span className="aipane__hitl-q-num" aria-hidden>?</span>}
              title={question.question}
              titleClassName="aipane__hitl-question-title"
              rowClassName="aipane__hitl-question-row"
              open
              expandable={false}
              onToggle={() => undefined}
            >
              {question.detail && <p className="aipane__hitl-q-detail">{question.detail}</p>}
              {question.options?.length ? (
                <>
                  <span className="aipane__hitl-q-detail">{multi ? '可选择多项' : '请选择一项'}</span>
                  <div
                    className="aipane__hitl-options"
                    role={multi ? 'group' : 'radiogroup'}
                    aria-label={question.question}
                  >
                    {question.options.map((option) => {
                      const active = current.includes(option.label);
                      return (
                        <button
                          key={option.label}
                          type="button"
                          disabled={submitting}
                          role={multi ? 'checkbox' : 'radio'}
                          aria-checked={active}
                          className={`aipane__hitl-opt${active ? ' is-on' : ''}`}
                          onClick={() => onToggle(question.id, option.label, multi)}
                        >
                          <span className="aipane__hitl-opt-glyph" aria-hidden="true">{active ? '✓' : ''}</span>
                          <span className="aipane__hitl-opt-label">{option.label}</span>
                          {option.description && (
                            <span className="aipane__hitl-opt-desc">{option.description}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </>
              ) : (
                <span className="aipane__hitl-q-detail">此问题无需选择，提交即可继续</span>
              )}
            </DisclosureRow>
          );
        })}
      </div>
      <div className="aipane__hitl-actions">
        {error && <p role="alert" className="aipane__hitl-error">{error}</p>}
        <Button variant="ghost" onClick={onSkip} disabled={submitting}>跳过</Button>
        <Button variant="primary" onClick={onSubmit} disabled={!ready || submitting}>
          {submitting ? '提交中…' : error ? '重试提交' : '提交答案'}
        </Button>
      </div>
    </div>
  );
}
