/**
 * Clinical forms — public interface used by other features (IPD chart, ER, OPD, OT, discharge).
 *
 *   <FormLibrary patientId encounterId suites={['nursing']} />      library + runner (search, favourites, suites)
 *   <FormRunner patientId encounterId formKey="nursing.morse" />     one form: new entry or recordId
 *   <IoFlowsheet patientId encounterId />                            intake / output with clinical-day balance
 *   <OtBooklet patientId encounterId bookingId />                    21-sheet OT file
 *   <FormHistory patientId encounterId suite limit />                recent entries + latest scores
 *   <DictationButton onText /> · <TemplatePicker onInsert field /> · <NarrativeTextarea …/>   narrative helpers
 *
 * Form keys: see GET /api/forms/defs (e.g. "discharge.summary", "op.note.<specialty>" — GET /api/forms/op-format?department_id=).
 * Every component shows only what the signed-in role may view / fill / sign (enforced again by the API).
 */
export type { FormContext } from './types'
export type { Entry, EntryRow, FormDef, FormSummary, Answers, Band } from './types'
export { FormLibrary } from './FormLibrary'
export { FormRunner, ScoreBar, type FormRunnerProps } from './FormRunner'
export { IoFlowsheet, BalanceView } from './IoFlowsheet'
export { OtBooklet, useBooklet } from './OtBooklet'
export { FormHistory, LatestScores, useLatestScores } from './FormHistory'
export {
  CopyFromMenu, DictationButton, dictationSupported, FieldHistoryButton, joinText, NarrativeTextarea, NarrativeTools, TemplatePicker, useDictation,
} from './narrative'
export { evaluate, missingRequired } from './logic'
export { useEntries, useEntry, useFormDef, useFormDefs } from './api'
