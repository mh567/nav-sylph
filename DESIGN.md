---
name: Nav Sylph
description: 自托管导航工作区，提供经典浅深色与暗玻璃主题。
colors:
  classic-light-bg: "#efede8"
  classic-light-surface: "#faf8f4"
  classic-light-text: "#302b27"
  classic-light-accent: "#945e4a"
  classic-dark-bg: "#211f1c"
  classic-dark-surface: "#3a3530"
  classic-dark-text: "#f3eee8"
  classic-dark-accent: "#c28d70"
  prism-bg: "#1b232b"
  prism-card: "#27323b"
  prism-text: "#f3f4f6"
  prism-secondary: "#c2cbd3"
  prism-muted: "#a3afbb"
  prism-border: "rgba(255,255,255,.08)"
  prism-accent: "#ededf0"
  prism-focus: "#bfc3ce"
rounded:
  category: "28px"
  mobile-category: "26px"
  input: "12px"
  pill: "999px"
typography:
  interface:
    fontFamily: "'Sylph Inter Tight', 'SF Pro Display', 'PingFang SC', 'Microsoft YaHei', sans-serif"
  category-title:
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.25
  bookmark-title:
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.5
components:
  category-card:
    backgroundColor: "rgba(19,29,38,.38)"
    textColor: "{colors.prism-text}"
    rounded: "{rounded.category}"
  search-control:
    backgroundColor: "rgba(18,29,39,.24)"
    textColor: "{colors.prism-text}"
    rounded: "{rounded.pill}"
---

# 设计系统：Nav Sylph

## Overview

经典主题继续提供浅色与深色选择；`prism` 是固定深色风格，`theme` 仍控制经典主题的明暗偏好。棱镜主题将暗玻璃、方向反射与中性灰阶用于现有首页、模块、管理界面和浮层，沿用现有布局与交互。

## Colors

经典主题保留暖色画布、暖灰文字与陶土色强调。棱镜主题以青灰深色为底、白灰为文字，左上暖光、右侧青色冷光与底部淡蓝反射形成低饱和环境层次，主要操作保留细描边。

### 经典主题
- 浅色画布与表面：`#efede8`、`#faf8f4`；文字 `#302b27`；强调色 `#945e4a`。
- 深色画布与表面：`#211f1c`、`#3a3530`；文字 `#f3eee8`；强调色 `#c28d70`。

### 棱镜主题
- 页面底色 `#1b232b`，不透明卡片底色 `#27323b`；主文字 `#f3f4f6`，次级文字 `#c2cbd3`，弱化文字 `#a3afbb`。
- 细边使用 `rgba(255,255,255,.08)`；主操作描边使用 `linear-gradient(115deg,#f5d477,#d89e77 27%,#c5a8df 62%,#74b6c6)`。
- 背景局部环境色只用于页面背景，不作为控件的默认强调色。

## Typography

Latin 字符使用自托管 Sylph Inter Tight Variable（字重 100 至 900）；字体文件是 Latin 子集，中文回落至 SF Pro Display、PingFang SC、Microsoft YaHei 和系统 sans-serif。

### Hierarchy
- 分类标题：600，桌面 16px、手机 15px，行高 1.25，字距 `-.01em`。
- 书签标题：复用原版12px、600字重、单行截断与名称提示。
- 页脚链接：13px；输入、按钮及其他文字沿用对应组件既有字号。

## Layout

棱镜主题在600px及以下将后台五个分区入口排为三列换行，全部可见，并保留44px点击高度。

保留首页导航、分类、搜索和模块的现有布局行为。棱镜主题分类卡片使用桌面 `20px 24px`、手机 `20px 18px 16px` 内边距；桌面网格间距为 20px。书签排版直接继承styles.css：桌面96px固定列宽、8px间距、6px 8px内边距；600px及以下保持44px最小高度，480px及以下为容器内三列。

## Elevation & Depth

棱镜表面由透明白色反射层、暗色玻璃底、薄受光边和阴影共同形成深度。分类卡片使用 `blur(18px) saturate(140%)`；胶囊控件使用 `blur(16px) saturate(150%)`；下拉浮层使用 `blur(24px) saturate(150%)`，面板使用 `blur(24px) saturate(160%)`。支持减少透明度或不支持背景模糊时，回退为不透明卡片表面。

## Shapes

分类卡片圆角为 28px，手机为 26px；胶囊控件为 999px；输入框为 12px。卡片边框为 1px 中性白灰细边。各部件保留自己的圆角和间距，不推导统一尺寸。

## Components

### 分类卡片
- 以 150 度方向反射渐变叠加 `rgba(19,29,38,.38)` 玻璃底，配合内侧高光、下沿暗边与短投影。
- 分类标题为 16px（手机 15px）；书签文字沿用原版12px。

### 书签按钮
- 书签使用12px圆角按钮轮廓，保留原版宽高与排版，使用中性渐变底、细边与柔和投影。纯文字布局中的名称居中，带图标布局沿用图标与文字排列。
- 悬停提亮并上抬1px；按下下沉1px并缩放至.985，保留可见键盘焦点，桌面96px宽、42px最小高度，手机44px最小高度。材质变量限定于书签，模块列表不受影响。

### 搜索与按钮
- 搜索框最小高度 62px，胶囊表面采用纵向反光渐变与 `blur(16px) saturate(150%)`。
- 按钮沿用胶囊形态；主要操作使用深色渐变底与 115 度受光描边。悬停、按下和焦点沿用现有状态样式。

## Do's and Don'ts

### Do
- 保留经典浅色和深色主题及其既有暖色材质。
- 棱镜主题复用当前暗玻璃、150 度反射和中性灰阶。
- 保持 Latin 与中文的字体覆盖边界。

### Don't
- 不恢复棱镜旧版冷灰平面卡片、无模糊处理、纯系统字体或蓝色默认强调色。
- 不将背景光谱扩展为全界面的彩色强调。

## 匿名编辑抽屉

导航下方以带分隔线和旋转箭头的「收起设置 / 展开设置」入口界定设置区。导航基础与模块配置桌面并列，700px 及以下上下排列；保留同一层级的开放分组，避免嵌套卡片。导航基础内选择器宽度桌面156px、手机148px，标签左对齐、控件右对齐，长选项在按钮内省略并在面板完整呈现。

选择器沿用当前主题的控件渐变、文字、细边与悬浮面板。选项以选中勾标与悬停/键盘高亮区分状态，手机点击高度44px；固定深色的明暗按钮禁用。抽屉260ms抽拉、箭头220ms转向，减少动画时取消过渡。收起保留草稿，保存失败自动展开错误。

## 棱镜环境打光

背景采用静态冷暖大范围径向光，配合青灰纵向底色；环境光固定于视口，长页面不会在首屏之后退回纯黑。玻璃卡片使用 rgba(19,29,38,.38)，浮层使用 rgba(25,36,47,.84)，输入及主按钮一起提亮以维持层次。无新图片、外部资源、滤镜层或循环动画。主题仍为固定深色，排版、字号和书签尺寸保持原样。

## 首页主题快捷入口

在搜索上方靠右显示「经典 / 棱镜」分段按钮，默认选中棱镜。控件使用当前主题的下沉槽与抬起选中块，不改变既有字体和导航尺寸。桌面32px按钮，手机44px；可见焦点及aria-pressed表达选中态。访客和管理员均可直接切换并保存到各自配置；编辑和保存期间禁用顶部快捷入口，保留编辑区及后台主题设置。未指定视觉主题的历史配置呈现棱镜，显式经典配置继续沿用。

## 圆润玻璃材质修正

v2.2.5 的提亮使卡片不透明度升至72%、浮层升至96%，环境光难以透过，表面显得厚重。本轮保留青灰背景，将卡片降至38%、浮层降至84%，增加定向顶部高光、内侧阴影与柔和离面投影。搜索和顶部主题槽恢复半透明反光，书签表面改为弧面明暗过渡。分类卡片28px/手机26px圆角、书签12px圆角；按钮尺寸、字体、间距与保存交互保持原样。减少透明度时仍使用不透明回退。
