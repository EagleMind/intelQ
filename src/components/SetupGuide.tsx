import React, { useState } from 'react';
import {
  Database,
  Sparkles,
  MessageSquareText,
  Check,
  ChevronDown,
  Plug,
  ArrowRight,
} from 'lucide-react';
import { useDb } from '../store/DbContext';
import { useAiSettings } from '../store/AiSettingsContext';
import AiProviderForm from './AiProviderForm';

interface Props {
  /** Open the Connections manager modal (owned by the shell). */
  onOpenConnections: () => void;
  /** Enter the workspace without finishing every step (e.g. explore-only). */
  onEnter: () => void;
}

type StepState = 'done' | 'active' | 'todo';

interface StepShellProps {
  index: number;
  icon: React.ReactNode;
  title: string;
  summary: string;
  state: StepState;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

const StepShell: React.FC<StepShellProps> = ({
  index,
  icon,
  title,
  summary,
  state,
  open,
  onToggle,
  children,
}) => {
  return (
    <div
      className={`rounded-xl border transition-colors ${
        state === 'active'
          ? 'border-primary/60 bg-card shadow-sm'
          : 'border-border bg-card/60'
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-4 px-4 py-4 text-left cursor-pointer"
      >
        <div
          className={`flex items-center justify-center w-9 h-9 rounded-full shrink-0 font-semibold ${
            state === 'done'
              ? 'bg-success text-success-foreground'
              : state === 'active'
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary text-muted-foreground'
          }`}
        >
          {state === 'done' ? <Check className="w-5 h-5" /> : index}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">{icon}</span>
            <h3 className="text-base font-semibold text-foreground m-0">{title}</h3>
          </div>
          <p className="text-sm text-muted-foreground m-0 mt-0.5">{summary}</p>
        </div>

        <ChevronDown
          className={`w-5 h-5 text-muted-foreground shrink-0 transition-transform ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {open && <div className="px-4 pb-5 pl-[4.5rem]">{children}</div>}
    </div>
  );
};

const SetupGuide: React.FC<Props> = ({ onOpenConnections, onEnter }) => {
  const { status, disconnect } = useDb();
  const { aiReady, provider } = useAiSettings();

  const connected = status.connected;

  // Step 2 only counts as done once the user has explicitly saved a provider
  // *and* it has what it needs — otherwise the pre-filled LM Studio default
  // would silently complete the step and skip the user past it.
  const [aiConfirmed, setAiConfirmed] = useState(false);
  const aiDone = aiConfirmed && aiReady;

  // The current step is the first incomplete one.
  const current = !connected ? 1 : !aiDone ? 2 : 3;
  const [openOverride, setOpenOverride] = useState<number | null>(null);
  const openStep = openOverride ?? current;

  const stateOf = (step: number): StepState => {
    if (step === 1) return connected ? 'done' : 'active';
    if (step === 2) return aiDone ? 'done' : connected ? 'active' : 'todo';
    return connected && aiDone ? 'active' : 'todo';
  };

  const toggle = (step: number) => setOpenOverride(prev => (prev === step ? -1 : step));

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 py-10">
        <div className="mb-8 text-center">
          <h2 className="text-2xl font-bold text-foreground m-0">Let’s get you querying</h2>
          <p className="text-muted-foreground mt-2 mb-0">
            Three quick steps and you’ll be asking your database questions in plain English.
          </p>
        </div>

        <div className="space-y-3">
          {/* Step 1 — Connect a database */}
          <StepShell
            index={1}
            icon={<Database className="w-4 h-4" />}
            title="Connect a database"
            summary={
              connected
                ? `Connected to ${status.connectionName ?? 'your database'}`
                : 'Point IntelQuery at a Postgres, MySQL, or SQLite database.'
            }
            state={stateOf(1)}
            open={openStep === 1}
            onToggle={() => toggle(1)}
          >
            {connected ? (
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm text-muted-foreground">
                  You’re connected. You can manage or switch connections any time.
                </span>
                <button className="btn btn-secondary btn-sm" onClick={onOpenConnections}>
                  Manage connections
                </button>
                <button className="btn btn-secondary btn-sm" onClick={disconnect}>
                  Disconnect
                </button>
              </div>
            ) : (
              <div>
                <p className="text-sm text-muted-foreground mt-0 mb-3">
                  Credentials are stored in your OS keychain — never in plain text.
                </p>
                <button className="btn btn-primary" onClick={onOpenConnections}>
                  <Plug className="w-4 h-4" />
                  Add a connection
                </button>
              </div>
            )}
          </StepShell>

          {/* Step 2 — Configure the AI provider */}
          <StepShell
            index={2}
            icon={<Sparkles className="w-4 h-4" />}
            title="Choose your AI provider"
            summary={
              aiDone
                ? provider === 'lmstudio'
                  ? 'LM Studio (local) — ready'
                  : 'OpenRouter — API key set'
                : 'This turns your questions into SQL. Pick local or cloud, then save.'
            }
            state={stateOf(2)}
            open={openStep === 2}
            onToggle={() => toggle(2)}
          >
            <AiProviderForm
              saveLabel="Save & continue"
              onSaved={() => {
                setAiConfirmed(true);
                setOpenOverride(null);
              }}
            />
          </StepShell>

          {/* Step 3 — Ask questions */}
          <StepShell
            index={3}
            icon={<MessageSquareText className="w-4 h-4" />}
            title="Ask in plain English"
            summary="Describe what you want — IntelQuery writes and runs the SQL."
            state={stateOf(3)}
            open={openStep === 3}
            onToggle={() => toggle(3)}
          >
            {!connected ? (
              <p className="text-sm text-muted-foreground m-0">
                Finish step 1 first — you’ll need a database to query.
              </p>
            ) : aiDone ? (
              <div>
                <p className="text-sm text-muted-foreground mt-0 mb-3">
                  Everything’s ready. Jump into the workspace and ask your first question.
                </p>
                <button className="btn btn-primary" onClick={onEnter}>
                  Enter workspace
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div>
                <p className="text-sm text-muted-foreground mt-0 mb-3">
                  Your AI provider isn’t configured yet, so natural-language queries won’t work.
                  You can still browse your tables and set it up later from the workspace.
                </p>
                <button className="btn btn-secondary" onClick={onEnter}>
                  Explore tables without AI
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            )}
          </StepShell>
        </div>
      </div>
    </div>
  );
};

export default SetupGuide;
