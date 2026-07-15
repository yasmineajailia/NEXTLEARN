"""
js_forest.py

Reconstructs the EXACT production `ml-random-forest` model (data/rf-model.json,
trained by scripts/train-model.ts) as a scikit-learn RandomForestClassifier so
that the real `shap` TreeExplainer can read and explain it directly — no
re-trained mirror, no fidelity gap.

Key details of the JS serialization:
  * baseModel.estimators[i]  – one ml-cart tree.
  * baseModel.indexes[i]     – the (bootstrapped, with-replacement) feature
                               columns tree i was trained on. A node's
                               `splitColumn` is a LOCAL index into this list, so
                               the global feature = indexes[i][splitColumn].
  * internal node            – { splitColumn, splitValue, left, right, numberSamples }.
  * leaf node                – { distribution: [[count0, count1]] }.
  * the forest predicts by HARD voting: predictProbability(_, 1) = fraction of
    trees whose leaf argmax is class 1. We reproduce that by making each sklearn
    leaf ONE-HOT (argmax class), so RF soft-averaging == JS hard voting.
"""

import json
import os

import numpy as np
from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
from sklearn.tree import DecisionTreeClassifier, DecisionTreeRegressor
from sklearn.tree._tree import Tree

# Read the feature count from the list the training scripts wrote next to the
# model, so this never has to be kept in sync by hand (it silently wasn't, once).
def _load_n_features(default: int = 9) -> int:
    meta = os.path.join(os.getcwd(), "data", "model-features.json")
    try:
        with open(meta, encoding="utf-8") as fh:
            return len(json.load(fh))
    except Exception:
        return default


N_FEATURES = _load_n_features()
N_CLASSES = 2

# Grab this sklearn build's exact node struct dtype from a throwaway fitted tree,
# so we stay compatible across sklearn versions.
_template = DecisionTreeClassifier(max_depth=1).fit([[0] * N_FEATURES, [1] * N_FEATURES], [0, 1])
NODE_DTYPE = _template.tree_.__getstate__()["nodes"].dtype


def _is_leaf(node: dict) -> bool:
    return "distribution" in node


def _leaf_one_hot(node: dict) -> list:
    """
    Reproduce ml-cart's leaf class = distribution.maxRowIndex (argmax column).
    Distributions are normalized probabilities. Because getNumberOfClasses uses
    max(label)+1, a 1-column [[p]] means only class 0 was present → class 0.
    """
    dist = node["distribution"][0]
    if len(dist) == 1:
        return [1.0, 0.0]  # only class 0 present
    p0, p1 = float(dist[0]), float(dist[1])
    return [0.0, 1.0] if p1 > p0 else [1.0, 0.0]


def _build_sklearn_tree(root: dict, feat_map: list) -> Tree:
    """Flatten one ml-cart tree into a populated sklearn Tree object."""
    nodes: list = []
    values: list = []

    def rec(node: dict) -> int:
        idx = len(nodes)
        nodes.append(None)
        values.append(None)

        if _is_leaf(node):
            # One-hot the leaf's argmax class → reproduces the JS forest's hard voting.
            one_hot = _leaf_one_hot(node)
            nodes[idx] = (-1, -1, -2, -2.0, 0.0, 1, 1.0, 0)
            values[idx] = [one_hot]
        else:
            left_id = rec(node["left"])
            right_id = rec(node["right"])
            feat = int(feat_map[int(node["splitColumn"])])
            thr = float(node["splitValue"])
            n = float(node.get("numberSamples", 0) or 0)
            nodes[idx] = (left_id, right_id, feat, thr, 0.0, int(n), n, 0)
            # Internal value = counts summed from children (unused for prediction).
            values[idx] = [[values[left_id][0][k] + values[right_id][0][k] for k in range(N_CLASSES)]]

        return idx

    rec(root)

    node_count = len(nodes)
    node_arr = np.zeros(node_count, dtype=NODE_DTYPE)
    names = NODE_DTYPE.names
    # (left_child, right_child, feature, threshold, impurity, n_node_samples,
    #  weighted_n_node_samples, missing_go_to_left) — set only fields that exist.
    for i, (lc, rc, feat, thr, imp, nns, wns, mgl) in enumerate(nodes):
        node_arr[i]["left_child"] = lc
        node_arr[i]["right_child"] = rc
        node_arr[i]["feature"] = feat
        node_arr[i]["threshold"] = thr
        node_arr[i]["impurity"] = imp
        node_arr[i]["n_node_samples"] = nns
        node_arr[i]["weighted_n_node_samples"] = wns
        if "missing_go_to_left" in names:
            node_arr[i]["missing_go_to_left"] = mgl

    value_arr = np.array(values, dtype=np.float64).reshape(node_count, 1, N_CLASSES)

    max_depth = _tree_depth(nodes)
    tree = Tree(N_FEATURES, np.array([N_CLASSES], dtype=np.intp), 1)
    tree.__setstate__({
        "max_depth": max_depth,
        "node_count": node_count,
        "nodes": node_arr,
        "values": value_arr,
    })
    return tree


def _tree_depth(nodes: list) -> int:
    # nodes are appended pre-order; compute depth by walking children.
    def depth(i: int) -> int:
        lc, rc = nodes[i][0], nodes[i][1]
        if lc == -1:
            return 0
        return 1 + max(depth(lc), depth(rc))
    return depth(0)


def load_js_forest(model_path: str) -> RandomForestClassifier:
    """Load data/rf-model.json and return an equivalent sklearn RandomForestClassifier."""
    with open(model_path, "r", encoding="utf-8") as fh:
        payload = json.load(fh)
    bm = payload["baseModel"]
    estimators = bm["estimators"]
    indexes = bm["indexes"]

    trees = []
    for i, est in enumerate(estimators):
        sk_tree = _build_sklearn_tree(est["root"], indexes[i])
        dtc = DecisionTreeClassifier()
        dtc.tree_ = sk_tree
        dtc.n_features_in_ = N_FEATURES
        dtc.n_classes_ = N_CLASSES
        dtc.classes_ = np.array([0, 1])
        dtc.n_outputs_ = 1
        trees.append(dtc)

    rf = RandomForestClassifier(n_estimators=len(trees))
    rf.estimators_ = trees
    rf.n_features_in_ = N_FEATURES
    rf.n_classes_ = N_CLASSES
    rf.classes_ = np.array([0, 1])
    rf.n_outputs_ = 1
    return rf


def _build_sklearn_regression_tree(root: dict, feat_map: list) -> Tree:
    """Flatten one ml-cart REGRESSION tree (numeric leaves) into an sklearn Tree."""
    nodes: list = []
    values: list = []

    def rec(node: dict) -> int:
        idx = len(nodes)
        nodes.append(None)
        values.append(None)

        if _is_leaf(node):
            # Regression leaf: distribution is the mean of y in that leaf.
            nodes[idx] = (-1, -1, -2, -2.0, 0.0, 1, 1.0, 0)
            values[idx] = [[float(node["distribution"])]]
        else:
            left_id = rec(node["left"])
            right_id = rec(node["right"])
            feat = int(feat_map[int(node["splitColumn"])])
            thr = float(node["splitValue"])
            n = float(node.get("numberSamples", 0) or 0)
            nodes[idx] = (left_id, right_id, feat, thr, 0.0, int(n), n, 0)
            # Internal value: mean of children (unused by interventional SHAP/predict).
            values[idx] = [[(values[left_id][0][0] + values[right_id][0][0]) / 2.0]]

        return idx

    rec(root)

    node_count = len(nodes)
    node_arr = np.zeros(node_count, dtype=NODE_DTYPE)
    names = NODE_DTYPE.names
    for i, (lc, rc, feat, thr, imp, nns, wns, mgl) in enumerate(nodes):
        node_arr[i]["left_child"] = lc
        node_arr[i]["right_child"] = rc
        node_arr[i]["feature"] = feat
        node_arr[i]["threshold"] = thr
        node_arr[i]["impurity"] = imp
        node_arr[i]["n_node_samples"] = nns
        node_arr[i]["weighted_n_node_samples"] = wns
        if "missing_go_to_left" in names:
            node_arr[i]["missing_go_to_left"] = mgl

    value_arr = np.array(values, dtype=np.float64).reshape(node_count, 1, 1)

    tree = Tree(N_FEATURES, np.array([1], dtype=np.intp), 1)
    tree.__setstate__({
        "max_depth": _tree_depth(nodes),
        "node_count": node_count,
        "nodes": node_arr,
        "values": value_arr,
    })
    return tree


def load_js_regression_forest(model_path: str) -> RandomForestRegressor:
    """
    Load a serialized ml-random-forest RandomForestRegression (e.g.
    data/rf-grade-model.json) as an equivalent sklearn RandomForestRegressor.
    Both aggregate by averaging tree outputs, so predictions match exactly.
    """
    with open(model_path, "r", encoding="utf-8") as fh:
        payload = json.load(fh)
    bm = payload["baseModel"]

    trees = []
    for i, est in enumerate(bm["estimators"]):
        sk_tree = _build_sklearn_regression_tree(est["root"], bm["indexes"][i])
        dtr = DecisionTreeRegressor()
        dtr.tree_ = sk_tree
        dtr.n_features_in_ = N_FEATURES
        dtr.n_outputs_ = 1
        trees.append(dtr)

    rf = RandomForestRegressor(n_estimators=len(trees))
    rf.estimators_ = trees
    rf.n_features_in_ = N_FEATURES
    rf.n_outputs_ = 1
    return rf


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    rf = load_js_forest(os.path.join(here, "..", "data", "rf-model.json"))
    print(f"Loaded {len(rf.estimators_)} classifier trees.")
    sample = np.array([[9, 0.6, 38, 0.5, 0.8, 0.05, 0.7]], dtype=float)
    print("predict_proba(class1):", rf.predict_proba(sample)[0][1])
    grade_rf = load_js_regression_forest(os.path.join(here, "..", "data", "rf-grade-model.json"))
    print(f"Loaded {len(grade_rf.estimators_)} regression trees.")
    print("predicted grade:", grade_rf.predict(sample)[0])
