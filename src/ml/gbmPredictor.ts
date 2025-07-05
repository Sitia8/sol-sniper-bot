/*
 LightGBM predictor for inference in the bot (buy / sell models).
 Works with the JSON dump produced via Python: `booster.dump_model()`.
*/

import { readFileSync } from 'fs';

export interface TreeNode {
  split_index?: number;
  split_feature?: number;
  threshold?: number;
  decision_type?: string;
  default_left?: boolean;
  left_child?: TreeNode;
  right_child?: TreeNode;
  leaf_index?: number;
  leaf_value?: number;
}

export interface BoosterDump {
  init_score?: number;
  num_trees: number;
  tree_info: { tree_structure: TreeNode }[];
}

export class GbmPredictor {
  private trees: TreeNode[];
  private initScore: number;

  constructor(dump: BoosterDump | string) {
    const model: BoosterDump = typeof dump === 'string' ? JSON.parse(readFileSync(dump, 'utf8')) : dump;
    this.initScore = Number(model.init_score ?? 0);
    this.trees = model.tree_info.map(t => t.tree_structure);
  }

  private scoreTree(node: TreeNode, feats: number[]): number {
    // leaf
    if (node.leaf_value !== undefined) return node.leaf_value;
    const featureIdx = node.split_feature ?? 0;
    const fVal = feats[featureIdx] ?? 0;
    const goLeft = fVal <= (node.threshold ?? 0);
    return this.scoreTree(goLeft ? (node.left_child as TreeNode) : (node.right_child as TreeNode), feats);
  }

  /** Return probability (sigmoid) */
  predict(feats: number[]): number {
    let score = this.initScore;
    for (const tree of this.trees) {
      score += this.scoreTree(tree, feats);
    }
    return 1 / (1 + Math.exp(-score));
  }
}
