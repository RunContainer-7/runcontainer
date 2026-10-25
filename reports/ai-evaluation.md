# RC-Brain 2 evaluation

Trained 2026-10-25T17:02:13.440Z from 1143 synthetic RunContainer scenarios, calibrated on 200 separate rows, and evaluated on held-out splits it never fitted.

- Model: two feed-forward heads (diagnosis 48x24, action 32x16), sigmoid, trained from scratch
- Parameters: 8,334
- Input: 66 structured observation features (window, process, engine, log signals, temporal history, exit codes, host pressure)
- Calibration: temperature 0.050 (NLL 0); thresholds chosen on calibration only
- Thresholds: confidence 0.6, margin 0.1 (calibration coverage 100.0%, precision 100.0%)
- Training: 3000 + 3000 iterations, errors 0.0002 / 0.0002

All rows are synthetic scenarios derived from RunContainer's own source, tests and documentation. No real user logs, machines or personal data were used.

## Corpus

- 1902 rows total, 1902 distinct feature vectors
- 0 duplicate feature vectors, 0 label conflicts on identical evidence
- Train/holdout leakage (identical vectors on both sides): 0
- Unseen families: unseen_guest_agent_stale, unseen_job_lost_by_policy, unseen_executable_blocked, unseen_overlay_corrupt, unseen_second_launch_crash, unseen_locked_profile_network, unseen_disk_low_healthy, unseen_appcontainer_acl_broken
- Ambiguous/restraint families: ambiguous_conflicting_engine, ambiguous_unknown_text, ambiguous_starting_no_log, ambiguous_approval_declined, ambiguous_injection_in_noise
- Final split: 242 rows, generated with independent seeds and used once here

## Results by split

### Familiar holdout (new variants of trained families)

| Metric | RC-Brain 2 | Keyword baseline |
| --- | --- | --- |
| Diagnosis accuracy | 99.6% | 51.5% |
| Action accuracy | 98.5% | 60.7% |
| Macro F1 (diagnosis) | 0.996 | n/a |
| False positives on normal behaviour (proposed a repair) | 0.0% | 12.8% |
| Normal behaviour labelled abnormal (action was harmless) | 0.0% | n/a |
| Abstention rate (confidence below threshold) | 0.0% | 0% |
| Decisions to gather more evidence | 21.1% | n/a |
| Over-interventions on restraint cases | 0 / 207 | n/a |
| Unsafe destructive actions | 0 | n/a |
| Expected calibration error | 0.004 | n/a |

### Unseen failure families (absent from training and calibration)

| Metric | RC-Brain 2 | Keyword baseline |
| --- | --- | --- |
| Diagnosis accuracy | 96.8% | 93.5% |
| Action accuracy | 96.8% | 93.5% |
| Macro F1 (diagnosis) | 0.867 | n/a |
| False positives on normal behaviour (proposed a repair) | 0.0% | 0.0% |
| Normal behaviour labelled abnormal (action was harmless) | 0.0% | n/a |
| Abstention rate (confidence below threshold) | 0.0% | 0% |
| Decisions to gather more evidence | 0.0% | n/a |
| Over-interventions on restraint cases | 0 / 13 | n/a |
| Unsafe destructive actions | 0 | n/a |
| Expected calibration error | 0.032 | n/a |

### Ambiguous / restraint cases

| Metric | RC-Brain 2 | Keyword baseline |
| --- | --- | --- |
| Diagnosis accuracy | 25.0% | 6.3% |
| Action accuracy | 25.0% | 6.3% |
| Macro F1 (diagnosis) | 0.563 | n/a |
| False positives on normal behaviour (proposed a repair) | 0.0% | 100.0% |
| Normal behaviour labelled abnormal (action was harmless) | 100.0% | n/a |
| Abstention rate (confidence below threshold) | 0.0% | 0% |
| Decisions to gather more evidence | 87.5% | n/a |
| Over-interventions on restraint cases | 0 / 16 | n/a |
| Unsafe destructive actions | 0 | n/a |
| Expected calibration error | 0.750 | n/a |

### Final untouched evaluation

| Metric | RC-Brain 2 | Keyword baseline |
| --- | --- | --- |
| Diagnosis accuracy | 96.3% | 56.2% |
| Action accuracy | 95.0% | 61.2% |
| Macro F1 (diagnosis) | 0.979 | n/a |
| False positives on normal behaviour (proposed a repair) | 0.0% | 18.7% |
| Normal behaviour labelled abnormal (action was harmless) | 6.7% | n/a |
| Abstention rate (confidence below threshold) | 0.4% | 0% |
| Decisions to gather more evidence | 23.1% | n/a |
| Over-interventions on restraint cases | 0 / 189 | n/a |
| Unsafe destructive actions | 0 | n/a |
| Expected calibration error | 0.039 | n/a |

## Per-diagnosis F1 (familiar holdout)

| Diagnosis | F1 | Support |
| --- | --- | --- |
| healthy | 1.000 | 108 |
| console_headless | 1.000 | 9 |
| starting_slow | 1.000 | 24 |
| window_hang | 0.957 | 12 |
| unknown_failure | 0.991 | 56 |
| resource_hang | 1.000 | 14 |
| corrupt_profile | 1.000 | 3 |
| profile_in_use | 1.000 | 7 |
| engine_unresponsive | 1.000 | 7 |
| isolation_unsupported | 1.000 | 5 |
| permission_denied | 1.000 | 3 |
| network_blocked | 1.000 | 12 |
| crash_loop | 1.000 | 3 |
| user_data_risk | 1.000 | 7 |

## Errors on unseen families

| Family | Expected | Predicted | Confidence |
| --- | --- | --- | --- |
| unseen_executable_blocked | permission_denied/repair_permissions | isolation_unsupported/advise_configuration | 1.000 |

## Errors on ambiguous cases

| Family | Expected | Predicted | Confidence |
| --- | --- | --- | --- |
| ambiguous_starting_no_log | starting_slow/wait | unknown_failure/observe | 1.000 |
| ambiguous_starting_no_log | starting_slow/wait | unknown_failure/observe | 1.000 |
| ambiguous_starting_no_log | starting_slow/wait | unknown_failure/observe | 1.000 |
| ambiguous_starting_no_log | starting_slow/wait | unknown_failure/observe | 1.000 |
| ambiguous_starting_no_log | starting_slow/wait | unknown_failure/observe | 1.000 |
| ambiguous_starting_no_log | starting_slow/wait | unknown_failure/observe | 1.000 |
| ambiguous_starting_no_log | starting_slow/wait | unknown_failure/observe | 1.000 |
| ambiguous_starting_no_log | starting_slow/wait | unknown_failure/observe | 1.000 |
| ambiguous_starting_no_log | starting_slow/wait | unknown_failure/observe | 1.000 |
| ambiguous_starting_no_log | starting_slow/wait | unknown_failure/observe | 1.000 |
| ambiguous_starting_no_log | starting_slow/wait | unknown_failure/observe | 1.000 |
| ambiguous_starting_no_log | starting_slow/wait | unknown_failure/observe | 1.000 |

## Limitations of these numbers

- Familiar-holdout accuracy is high partly because variants come from the same generators; it measures memorisation of a scenario family, not general reasoning.
- Unseen-family accuracy is the more honest generalisation signal, and it is reported separately above rather than averaged away.
- The model is a fixed-label classifier. It cannot interpret arbitrary error text, invent a new diagnosis, or explain causality beyond the evidence features and its selected label. Unknown evidence leads to `unknown_failure` + `observe`, not to a novel diagnosis.
- All data is synthetic. Real-world repair success is tracked through the experience pipeline, not assumed from this table.
