/*
 * JobDurationModel JS methods. Training and scoring are in JobDurationModel.py.
 */

function latest() {
  var res = JobDurationModel.Run.fetch({ order: 'descending(trainedAt)', limit: 1 });
  return res.objs && res.objs.length ? res.objs[0] : null;
}
