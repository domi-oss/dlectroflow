"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { saveDisplayName } from "@/app/actions/account";
import {
  useSaveStatus,
  SaveIndicator,
} from "@/components/settings/use-save-status";
// The bound lives in constants, not beside the action that enforces it: a
// `"use server"` module may only export async functions. See its docblock.
import { MAX_DISPLAY_NAME_LENGTH } from "@/lib/constants";
import { t, type Voice } from "@/lib/strings";

/**
 * #252 — what this person wants the header to call them.
 *
 * `accountLabel()` used to answer that with the lowercased username the OAuth
 * provider issued, else eight characters of a cuid. This is the field that gives
 * it something better to read.
 *
 * ## Its own component, inside the Account section
 *
 * A name is person-scoped, so it belongs under Account rather than in a
 * workspace-scoped section — `Settings` has one row per workspace and this app
 * has multiple members per workspace, so a name stored there would be one name
 * for everybody in it. It is a separate component rather than more JSX inside
 * `AccountPanel` for the reason `ExportData` and `DeleteAccount` are: that panel
 * already owns a secret-handling flow with its own live region and its own
 * outcome union, and a second, unrelated write sharing them is how a message ends
 * up describing the wrong attempt.
 *
 * ## Debounced auto-save, no Save button
 *
 * `AgingSection`'s shape, and for its reasons: every settings section auto-saves
 * (`AppearanceSection`, `NotificationsSection`, `FocusTimerSection`,
 * `ShoppingSection`, `DemoSection` all do), the feedback vocabulary is
 * `useSaveStatus` / `SaveIndicator`, and one debounced write per pause is what
 * keeps a free-entry field from issuing a request per keystroke — which matters
 * more here than for a threshold, because the write revalidates the app layout.
 *
 * The explicit Save button next door belongs to the API key and stays there: a
 * secret has to be submitted deliberately, and clearing the field on success is
 * part of that flow. A name has neither property.
 *
 * ## A failed write says so, and does NOT roll back
 *
 * #227 audited the auto-saving sections for both halves — report the failure
 * *and* restore the control — and added a rollback to the three whose controls
 * are toggles. `AgingSection` deliberately has none, and this field follows it:
 * the value on screen is the user's own in-progress typing, so putting the
 * server's value back would delete what they are still writing. That is a worse
 * outcome than a stale-looking switch, and it is the failure the toggles do not
 * have. Reporting is the whole correct answer for a field the user is holding.
 *
 * A REFUSAL is also a failure. `saveDisplayName` returns `{ ok: false }` for a
 * name it will not store rather than throwing, so a component that only caught
 * rejections would report success for it. In practice the field makes that
 * unreachable — `maxLength` bounds the length and a single-line input strips the
 * newlines that are the other refusal — but the action is a public POST endpoint
 * and this component is not its gate, so both outcomes are handled.
 */
export function DisplayNameField({
  displayName,
  voice,
  autoSaveDelayMs = 600,
}: {
  /** `User.displayName`, or `null` for an account that never set one. */
  displayName: string | null;
  voice: Voice;
  /** Debounce before the write. Overridable so tests stay fast and deterministic. */
  autoSaveDelayMs?: number;
}) {
  const router = useRouter();
  const fieldId = useId();
  const hintId = useId();
  const [name, setName] = useState(displayName ?? "");
  const { status, markSaving, markSaved, markError } = useSaveStatus();

  // The debounced flush reads the latest value from a ref rather than from its
  // own closure, and the ref is updated in an effect rather than during render —
  // `AgingSection`'s shape exactly.
  const valueRef = useRef(name);
  useEffect(() => {
    valueRef.current = name;
  });

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const flush = async () => {
    markSaving();
    try {
      const result = await saveDisplayName(valueRef.current);
      // A refusal did not throw, so it has to be checked. `markSaved()` here
      // would claim a write the server declined to make.
      if (!result.ok) {
        markError();
        return;
      }
      markSaved();
      // The label lives in the app shell, so without this the header keeps
      // showing the old one until the next navigation.
      router.refresh();
    } catch {
      markError();
    }
  };

  const schedule = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void flush(), autoSaveDelayMs);
  };

  return (
    <div className="space-y-2">
      <label htmlFor={fieldId} className="flex items-center gap-2 text-sm">
        <span className="font-medium">
          {t("settings.accountNameLabel", voice)}
        </span>
        {/* The shared auto-save vocabulary, beside the label rather than in the
            section heading: this field is one of three writes in the Account
            section, and an indicator in the heading band could not say which of
            them it was about. */}
        <SaveIndicator status={status} voice={voice} />
      </label>
      <p id={hintId} className="text-muted-foreground text-sm">
        {t("settings.accountNameHint", voice)}
      </p>
      <input
        id={fieldId}
        type="text"
        value={name}
        // The action's own bound, imported rather than restated: the field stops
        // accepting characters at exactly the length the server will accept, so
        // a refusal is not something a user can reach by typing.
        maxLength={MAX_DISPLAY_NAME_LENGTH}
        onChange={(e) => {
          setName(e.target.value);
          schedule();
        }}
        // A name is not a word: spell-correcting or auto-capitalising it would
        // rewrite it, and this one is rendered in the header of every page.
        // `autoComplete="nickname"` is the field's real meaning, so a browser
        // that can fill it should.
        autoComplete="nickname"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-describedby={hintId}
        // `min-h-11` for WCAG 2.5.5, matching the API-key field below it.
        className="border-input min-h-11 w-full max-w-sm rounded-md border px-3 py-2 text-sm"
      />
    </div>
  );
}
