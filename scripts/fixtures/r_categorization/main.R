# Categorization learning — R / shiny + saved CSV
# Two-category prototype-distortion task. Subjects learn to classify
# Gabors into category A (vertical-ish) or B (horizontal-ish).
#
# IVs:
#   block_kind: training (with feedback) vs test (no feedback)
#   stim_orientation: continuous, sampled per trial
# DVs: response, correct, rt

library(shiny)

# ----- experiment params -----------------------------------------------
N_TRAINING_BLOCKS <- 4
N_TEST_BLOCKS     <- 2
N_TRIALS_PER_BLOCK <- 50
ORIENT_RANGE <- c(-45, 45)        # degrees
PROTOTYPE_A <- 15                 # vertical-ish
PROTOTYPE_B <- -15                # horizontal-ish
ITI_MS <- 400
FEEDBACK_MS <- 800

# ----- runtime ---------------------------------------------------------
results <- data.frame(
  block = integer(),
  block_kind = character(),
  trial = integer(),
  orientation = numeric(),
  response = character(),
  correct = logical(),
  rt = numeric()
)

run_block <- function(kind, n_trials, block_idx) {
  for (t in seq_len(n_trials)) {
    orient <- runif(1, ORIENT_RANGE[1], ORIENT_RANGE[2])
    truth <- if (orient > 0) "A" else "B"
    # … show stimulus, collect keypress …
    response <- sample(c("A", "B"), 1)
    rt <- runif(1, 0.3, 1.4)
    correct <- response == truth
    results <<- rbind(results, data.frame(
      block = block_idx, block_kind = kind, trial = t,
      orientation = orient, response = response, correct = correct, rt = rt
    ))
    if (kind == "training") {
      Sys.sleep(FEEDBACK_MS / 1000)
    }
    Sys.sleep(ITI_MS / 1000)
  }
}

block_idx <- 0
for (i in seq_len(N_TRAINING_BLOCKS)) { block_idx <- block_idx + 1; run_block("training", N_TRIALS_PER_BLOCK, block_idx) }
for (i in seq_len(N_TEST_BLOCKS))     { block_idx <- block_idx + 1; run_block("test",     N_TRIALS_PER_BLOCK, block_idx) }

write.csv(results, "data/cat_results.csv", row.names = FALSE)
