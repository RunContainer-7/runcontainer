# RC-Brain 1 evaluation

Trained 2026-10-22T14:47:07.570Z from 894 synthetic RunContainer scenarios (plus 150 for temperature calibration); evaluated on 348 held-out variants never used for training or calibration.

- Model: two feed-forward heads (diagnosis 32x16, action 24x12)
- Parameters: 4,229
- Input: 44 structured observation features
- Calibration: temperature 0.125 (NLL 0.072)
- Training: 4000 + 4000 iterations, errors 0.0004 / 0.0011

## Held-out results

| Metric | RC-Brain 1 | Keyword baseline |
| --- | --- | --- |
| Diagnosis accuracy | 98.9% | 49.7% |
| Action accuracy | 98.9% | 58.6% |
| Macro F1 (diagnosis) | 0.985 | n/a |
| False positives on normal behaviour | 0.0% | n/a |
| Abstention rate | 2.0% | 0% |
| Unsafe actions | 0 | n/a |

## Per-diagnosis F1

| Diagnosis | F1 | Support |
| --- | --- | --- |
| healthy | 1.000 | 48 |
| console_headless | 1.000 | 12 |
| starting_slow | 1.000 | 24 |
| window_hang | 0.800 | 12 |
| unknown_failure | 0.923 | 24 |
| resource_hang | 1.000 | 24 |
| missing_runtime | 1.000 | 12 |
| crash_unhandled | 1.000 | 12 |
| corrupt_profile | 1.000 | 12 |
| engine_unresponsive | 1.000 | 36 |
| isolation_unsupported | 1.000 | 36 |
| permission_denied | 1.000 | 24 |
| disk_exhausted | 1.000 | 12 |
| network_blocked | 1.000 | 12 |
| installer_failed | 1.000 | 12 |
| crash_loop | 1.000 | 12 |
| user_data_risk | 1.000 | 12 |
| exited_normally | 1.000 | 12 |

## Misclassified held-out cases

| Family | Expected | Predicted | Confidence |
| --- | --- | --- | --- |
| window_hang | window_hang/restart_same_profile | unknown_failure/observe | 0.840 |
| window_hang | window_hang/restart_same_profile | unknown_failure/observe | 0.983 |
| window_hang | window_hang/restart_same_profile | unknown_failure/observe | 0.770 |
| window_hang | window_hang/restart_same_profile | unknown_failure/observe | 0.770 |

## Baseline comparison on failure families

| Family | Keyword baseline diagnosis accuracy |
| --- | --- |
| window_hang | 100.0% |
| resource_hang | 0.0% |
| missing_runtime | 50.0% |
| crash_unhandled | 75.0% |
| corrupt_profile | 0.0% |
| engine_trap_qemu | 100.0% |
| engine_trap_rcvm | 100.0% |
| isolation_unsupported | 50.0% |
| permission_denied | 58.3% |
| disk_exhausted | 100.0% |
| network_blocked | 100.0% |
| installer_failed | 0.0% |
| crash_loop | 75.0% |
| unknown_failure | 0.0% |
| user_data_risk | 33.3% |
| interaction_engine_and_runtime | 0.0% |
| interaction_hang_and_error_log | 0.0% |
| appcontainer_installer_unsupported | 100.0% |
| vm_disk_missing | 0.0% |
| denied_permission_approval | 100.0% |
| ambiguous_no_evidence | 0.0% |

The baseline is a transparent keyword matcher used only for comparison; it is not shipped as a decision maker.
