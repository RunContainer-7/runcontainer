# RC-Brain 5 evaluation

Trained 2026-10-27T13:03:22.053Z from 1398 synthetic RunContainer scenarios, calibrated on 237 separate rows, and evaluated on held-out splits it never fitted.

- Model: two feed-forward heads (diagnosis 64x32, action 48x24), sigmoid, trained from scratch
- Parameters: 13,632
- Input: 75 structured observation features (window, process, engine, log signals, temporal history, exit codes, host pressure, specialist-agent findings)
- Calibration: temperature 0.125 (NLL 0.0392); thresholds chosen on calibration only
- Thresholds: confidence 0.6, margin 0.1 (calibration coverage 100.0%, precision 99.6%)
- Training: 3000 + 3000 iterations, errors 0.0001 / 0.0002

All rows are synthetic scenarios derived from RunContainer's own source, tests and documentation. No real user logs, machines or personal data were used.

## Corpus

- 2341 rows total, 2341 distinct feature vectors
- 0 duplicate feature vectors, 0 label conflicts on identical evidence
- Train/holdout leakage (identical vectors on both sides): 0
- Unseen families: unseen_guest_agent_stale, unseen_job_lost_by_policy, unseen_executable_blocked, unseen_overlay_corrupt, unseen_second_launch_crash, unseen_locked_profile_network, unseen_disk_low_healthy, unseen_appcontainer_acl_broken, unseen_agents_setup_finished_new_exe, unseen_agents_unexplained_output, unseen_agents_reparse_link_present
- Ambiguous/restraint families: ambiguous_conflicting_engine, ambiguous_unknown_text, ambiguous_starting_no_log, ambiguous_approval_declined, ambiguous_injection_in_noise
- Final split: 310 rows, generated with independent seeds and used once here

## Results by split

### Familiar holdout (new variants of trained families)

| Metric | RC-Brain 5 | Keyword baseline |
| --- | --- | --- |
| Diagnosis accuracy | 99.7% | 45.3% |
| Action accuracy | 99.1% | 53.2% |
| Macro F1 (diagnosis) | 0.997 | n/a |
| False positives on normal behaviour (proposed a repair) | 0.0% | 21.0% |
| Normal behaviour labelled abnormal (action was harmless) | 0.0% | n/a |
| Abstention rate (confidence below threshold) | 0.3% | 0% |
| Decisions to gather more evidence | 19.3% | n/a |
| Over-interventions on restraint cases | 0 / 251 | n/a |
| Unsafe destructive actions | 0 | n/a |
| Expected calibration error | 0.009 | n/a |

### Unseen failure families (absent from training and calibration)

| Metric | RC-Brain 5 | Keyword baseline |
| --- | --- | --- |
| Diagnosis accuracy | 92.2% | 68.8% |
| Action accuracy | 92.2% | 68.8% |
| Macro F1 (diagnosis) | 0.858 | n/a |
| False positives on normal behaviour (proposed a repair) | 0.0% | 12.2% |
| Normal behaviour labelled abnormal (action was harmless) | 9.8% | n/a |
| Abstention rate (confidence below threshold) | 6.3% | 0% |
| Decisions to gather more evidence | 6.3% | n/a |
| Over-interventions on restraint cases | 0 / 54 | n/a |
| Unsafe destructive actions | 0 | n/a |
| Expected calibration error | 0.022 | n/a |

### Ambiguous / restraint cases

| Metric | RC-Brain 5 | Keyword baseline |
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
| Expected calibration error | 0.742 | n/a |

### Final untouched evaluation

| Metric | RC-Brain 5 | Keyword baseline |
| --- | --- | --- |
| Diagnosis accuracy | 94.8% | 48.1% |
| Action accuracy | 94.2% | 51.9% |
| Macro F1 (diagnosis) | 0.973 | n/a |
| False positives on normal behaviour (proposed a repair) | 0.0% | 26.2% |
| Normal behaviour labelled abnormal (action was harmless) | 8.1% | n/a |
| Abstention rate (confidence below threshold) | 1.6% | 0% |
| Decisions to gather more evidence | 21.3% | n/a |
| Over-interventions on restraint cases | 0 / 253 | n/a |
| Unsafe destructive actions | 0 | n/a |
| Expected calibration error | 0.030 | n/a |

## Per-diagnosis F1 (familiar holdout)

| Diagnosis | F1 | Support |
| --- | --- | --- |
| healthy | 1.000 | 129 |
| console_headless | 1.000 | 9 |
| starting_slow | 1.000 | 24 |
| window_hang | 0.957 | 12 |
| unknown_failure | 0.993 | 67 |
| resource_hang | 1.000 | 14 |
| corrupt_profile | 1.000 | 2 |
| profile_in_use | 1.000 | 7 |
| engine_unresponsive | 1.000 | 13 |
| isolation_unsupported | 1.000 | 4 |
| permission_denied | 1.000 | 1 |
| network_blocked | 1.000 | 12 |
| crash_loop | 1.000 | 3 |
| user_data_risk | 1.000 | 7 |
| installer_failed | 1.000 | 12 |

## Errors on unseen families

| Family | Expected | Predicted | Confidence |
| --- | --- | --- | --- |
| unseen_executable_blocked | permission_denied/repair_permissions | isolation_unsupported/consult_runbook | 0.937 |
| unseen_agents_setup_finished_new_exe | healthy/none | unknown_failure/observe | 0.138 |
| unseen_agents_setup_finished_new_exe | healthy/none | unknown_failure/observe | 0.076 |
| unseen_agents_setup_finished_new_exe | healthy/none | unknown_failure/observe | 0.086 |
| unseen_agents_setup_finished_new_exe | healthy/none | unknown_failure/observe | 0.515 |

## Errors on ambiguous cases

| Family | Expected | Predicted | Confidence |
| --- | --- | --- | --- |
| ambiguous_starting_no_log | starting_slow/wait | unknown_failure/observe | 0.992 |
| ambiguous_starting_no_log | starting_slow/wait | unknown_failure/observe | 0.992 |
| ambiguous_starting_no_log | starting_slow/wait | unknown_failure/observe | 0.993 |
| ambiguous_starting_no_log | starting_slow/wait | unknown_failure/observe | 0.991 |
| ambiguous_starting_no_log | starting_slow/wait | unknown_failure/observe | 0.991 |
| ambiguous_starting_no_log | starting_slow/wait | unknown_failure/observe | 0.992 |
| ambiguous_starting_no_log | starting_slow/wait | unknown_failure/observe | 0.992 |
| ambiguous_starting_no_log | starting_slow/wait | unknown_failure/observe | 0.992 |
| ambiguous_starting_no_log | starting_slow/wait | unknown_failure/observe | 0.993 |
| ambiguous_starting_no_log | starting_slow/wait | unknown_failure/observe | 0.992 |
| ambiguous_starting_no_log | starting_slow/wait | unknown_failure/observe | 0.992 |
| ambiguous_starting_no_log | starting_slow/wait | unknown_failure/observe | 0.992 |

## Limitations of these numbers

- Familiar-holdout accuracy is high partly because variants come from the same generators; it measures memorisation of a scenario family, not general reasoning.
- Unseen-family accuracy is the more honest generalisation signal, and it is reported separately above rather than averaged away.
- The model is a fixed-label classifier. It cannot interpret arbitrary error text, invent a new diagnosis, or explain causality beyond the evidence features and its selected label. Unknown evidence leads to `unknown_failure` + `observe`, not to a novel diagnosis.
- All data is synthetic. Real-world repair success is tracked through the experience pipeline, not assumed from this table.
