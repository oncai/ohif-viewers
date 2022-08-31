import cloneDeep from 'lodash.clonedeep';

import { pubSubServiceInterface } from '@ohif/core';
import {
  utilities as cstUtils,
  segmentation as cstSegmentation,
  CONSTANTS as cstConstants,
  Enums as cstEnums,
  Types as cstTypes,
} from '@cornerstonejs/tools';
import {
  eventTarget,
  cache,
  utilities as csUtils,
  volumeLoader,
  Types,
} from '@cornerstonejs/core';
import { Enums as csToolsEnums } from '@cornerstonejs/tools';

const { COLOR_LUT } = cstConstants;
const LABELMAP = csToolsEnums.SegmentationRepresentations.Labelmap;

type SegmentationConfig = cstTypes.LabelmapTypes.LabelmapConfig & {
  renderInactiveSegmentations: boolean;
  brushSize: number;
  brushThresholdGate: number;
};

type Segment = {
  // the label for the segment
  label: string;
  // the index of the segment in the segmentation
  segmentIndex: number;
  // the color of the segment
  color: Types.Point3;
  // the opacity of the segment
  opacity: number;
  // whether the segment is visible
  isVisible: boolean;
  // whether the segment is locked
  isLocked: boolean;
};

type Segmentation = {
  // active segment index is the index of the segment that is currently being edited.
  activeSegmentIndex: number;
  // colorLUTIndex is the index of the color LUT that is currently being used.
  colorLUTIndex: number;
  // if segmentation contains any data (often calculated from labelmap)
  cachedStats: Record<string, any>;
  // displayText is the text that is displayed on the segmentation panel (often derived from the data)
  displayText?: string[];
  // the id of the segmentation
  id: string;
  // if the segmentation is the active segmentation being used in the viewer
  isActive: boolean;
  // if the segmentation is visible in the viewer
  isVisible: boolean;
  // the label of the segmentation
  label: string;
  // the number of segments in the segmentation
  segmentCount: number;
  // the array of segments with their details
  segments: Segment[];
  // the set of segments that are locked
  segmentsLocked: Set<number>;
  // the segmentation representation type
  type: cstEnums.SegmentationRepresentations;
  // if labelmap, the id of the volume that the labelmap is associated with
  volumeId?: string;
};

// Schema to generate a segmentation
type SegmentationSchema = {
  // active segment index for the segmentation
  activeSegmentIndex: number;
  // statistics that are derived from the segmentation
  cachedStats: Record<string, number>;
  // the displayText for the segmentation in the panels
  displayText?: string[];
  // segmentation id
  id: string;
  // segmentation label
  label: string;
  // segment indices that are locked for the segmentation
  segmentsLocked: Set<number>;
  // the type of the segmentation (e.g., Labelmap etc.)
  type: cstEnums.SegmentationRepresentations;
  // the volume id of the volume that the labelmap is associated with, this only exists for the labelmap representation
  volumeId: string;
};

const EVENTS = {
  // fired when the segmentation is updated (e.g. when a segment is added, removed, or modified, locked, visibility changed etc.)
  SEGMENTATION_UPDATED: 'event::segmentation_updated',
  // fired when the segmentation data (e.g., labelmap pixels) is modified
  SEGMENTATION_DATA_MODIFIED: 'event::segmentation_data_modified',
  // fired when the segmentation is added to the cornerstone
  SEGMENTATION_ADDED: 'event::segmentation_added',
  // fired when the segmentation is removed
  SEGMENTATION_REMOVED: 'event::segmentation_removed',
  // fired when the configuration for the segmentation is changed (e.g., brush size, render fill, outline thickness, etc.)
  SEGMENTATION_CONFIGURATION_CHANGED:
    'event::segmentation_configuration_changed',
};

const VALUE_TYPES = {};

const EPSILON = 0.0001;

class SegmentationService {
  listeners = {};
  segmentations: Record<string, Segmentation>;
  servicesManager = null;
  _broadcastEvent: (eventName: string, callbackProps: any) => void;
  readonly EVENTS = EVENTS;

  private _suppressSegmentationModified = false;

  constructor({ servicesManager }) {
    this.segmentations = {};
    this.listeners = {};

    Object.assign(this, pubSubServiceInterface);

    this.servicesManager = servicesManager;

    this._initSegmentationService();
  }

  public destroy = () => {
    eventTarget.removeEventListener(
      csToolsEnums.Events.SEGMENTATION_MODIFIED,
      this._onSegmentationModified
    );

    eventTarget.removeEventListener(
      csToolsEnums.Events.SEGMENTATION_DATA_MODIFIED,
      this._onSegmentationDataModified
    );
  };

  /**
   * It adds a segment to a segmentation, basically just setting the properties for
   * the segment
   * @param segmentationId - The ID of the segmentation you want to add a
   * segment to.
   * @param segmentIndex - The index of the segment to add.
   * @param properties - The properties of the segment to add including
   * -- label: the label of the segment
   * -- color: the color of the segment
   * -- opacity: the opacity of the segment
   * -- visibility: the visibility of the segment (boolean)
   * -- isLocked: whether the segment is locked for editing
   * -- active: whether the segment is currently the active segment to be edited
   */
  public addSegment(
    segmentationId: string,
    segmentIndex: number,
    toolGroupId?: string,
    properties?: {
      label?: string;
      color?: Types.Point3;
      opacity?: number;
      visibility?: boolean;
      isLocked?: boolean;
      active?: boolean;
    }
  ): void {
    if (segmentIndex === 0) {
      throw new Error('Segment index 0 is reserved for "no label"');
    }

    toolGroupId = toolGroupId ?? this._getFirstToolGroupId();

    const {
      segmentationRepresentationUID,
      segmentation,
    } = this._getSegmentationInfo(segmentationId, toolGroupId);

    if (segmentation.segments[segmentIndex]) {
      throw new Error(`Segment ${segmentIndex} already exists`);
    }

    const rgbaColor = cstSegmentation.config.color.getColorForSegmentIndex(
      toolGroupId,
      segmentationRepresentationUID,
      segmentIndex
    );

    segmentation.segments[segmentIndex] = {
      label: properties.label,
      segmentIndex: segmentIndex,
      color: [rgbaColor[0], rgbaColor[1], rgbaColor[2]],
      opacity: rgbaColor[3],
      isVisible: true,
      isLocked: false,
    };

    segmentation.segmentCount++;

    const suppressEvents = true;
    if (properties !== undefined) {
      const {
        color: newColor,
        opacity,
        isLocked,
        visibility,
        active,
      } = properties;

      if (newColor !== undefined) {
        this._setSegmentColor(
          segmentationId,
          segmentIndex,
          newColor,
          toolGroupId,
          suppressEvents
        );
      }

      if (opacity !== undefined) {
        this._setSegmentOpacity(
          segmentationId,
          segmentIndex,
          opacity,
          toolGroupId,
          suppressEvents
        );
      }

      if (visibility !== undefined) {
        this._setSegmentVisibility(
          segmentationId,
          segmentIndex,
          visibility,
          toolGroupId,
          suppressEvents
        );
      }

      if (active !== undefined) {
        this._setActiveSegment(segmentationId, segmentIndex, suppressEvents);
      }

      if (isLocked !== undefined) {
        this._setSegmentLocked(
          segmentationId,
          segmentIndex,
          isLocked,
          suppressEvents
        );
      }
    }

    if (segmentation.activeSegmentIndex === null) {
      this._setActiveSegment(segmentationId, segmentIndex, suppressEvents);
    }

    this._broadcastEvent(this.EVENTS.SEGMENTATION_UPDATED, {
      segmentation,
    });
  }

  public removeSegment(segmentationId: string, segmentIndex: number): void {
    const segmentation = this.getSegmentation(segmentationId);

    if (segmentation === undefined) {
      throw new Error(`no segmentation for segmentationId: ${segmentationId}`);
    }

    if (segmentIndex === 0) {
      throw new Error('Segment index 0 is reserved for "no label"');
    }

    if (segmentation.segments[segmentIndex] === undefined) {
      return;
    }

    segmentation.segmentCount--;

    delete segmentation.segments[segmentIndex];

    // Get volume and delete the labels
    // Todo: handle other segmentations other than labelmap
    const labelmapVolume = this.getLabelmapVolume(segmentationId);

    const { scalarData, dimensions } = labelmapVolume;

    // Set all values of this segment to zero and get which frames have been edited.
    const frameLength = dimensions[0] * dimensions[1];
    const numFrames = dimensions[2];

    let voxelIndex = 0;

    const modifiedFrames = new Set() as Set<number>;

    for (let frame = 0; frame < numFrames; frame++) {
      for (let p = 0; p < frameLength; p++) {
        if (scalarData[voxelIndex] === segmentIndex) {
          scalarData[voxelIndex] = 0;
          modifiedFrames.add(frame);
        }

        voxelIndex++;
      }
    }

    const modifiedFramesArray: number[] = Array.from(modifiedFrames);

    // Trigger texture update of modified segmentation frames.
    cstSegmentation.triggerSegmentationEvents.triggerSegmentationDataModified(
      segmentationId,
      modifiedFramesArray
    );

    if (segmentation.activeSegmentIndex === segmentIndex) {
      const segmentIndices = Object.keys(segmentation.segments);

      const newActiveSegmentIndex = segmentIndices.length
        ? Number(segmentIndices[0])
        : 1;

      this._setActiveSegment(segmentationId, newActiveSegmentIndex, true);
    }

    this._broadcastEvent(this.EVENTS.SEGMENTATION_UPDATED, {
      segmentation,
    });
  }

  public setSegmentVisibility(
    segmentationId: string,
    segmentIndex: number,
    isVisible: boolean,
    toolGroupId?: string
  ): void {
    const suppressEvents = false;
    this._setSegmentVisibility(
      segmentationId,
      segmentIndex,
      isVisible,
      toolGroupId,
      suppressEvents
    );
  }

  public setSegmentLockedForSegmentation(
    segmentationId: string,
    segmentIndex: number,
    isLocked: boolean
  ): void {
    const suppressEvents = false;
    this._setSegmentLocked(
      segmentationId,
      segmentIndex,
      isLocked,
      suppressEvents
    );
  }

  public setSegmentLabel(
    segmentationId: string,
    segmentIndex: number,
    segmentLabel: string
  ): void {
    this._setSegmentLabel(segmentationId, segmentIndex, segmentLabel);
  }

  public setSegmentColor(
    segmentationId: string,
    segmentIndex: number,
    color: Types.Point3,
    toolGroupId?: string
  ): void {
    this._setSegmentColor(segmentationId, segmentIndex, color, toolGroupId);
  }

  public setSegmentRGBA = (
    segmentationId: string,
    segmentIndex: number,
    rgbaColor: cstTypes.Color,
    toolGroupId?: string
  ): void => {
    const segmentation = this.getSegmentation(segmentationId);

    if (segmentation === undefined) {
      throw new Error(`no segmentation for segmentationId: ${segmentationId}`);
    }

    const suppressEvents = true;
    this._setSegmentOpacity(
      segmentationId,
      segmentIndex,
      rgbaColor[3],
      toolGroupId,
      suppressEvents
    );

    this._setSegmentColor(
      segmentationId,
      segmentIndex,
      [rgbaColor[0], rgbaColor[1], rgbaColor[2]],
      toolGroupId,
      suppressEvents
    );

    this._broadcastEvent(this.EVENTS.SEGMENTATION_UPDATED, {
      segmentation,
    });
  };

  public setSegmentOpacity(
    segmentationId: string,
    segmentIndex: number,
    opacity: number,
    toolGroupId?: string
  ): void {
    this._setSegmentOpacity(segmentationId, segmentIndex, opacity, toolGroupId);
  }

  public setActiveSegmentationForToolGroup(
    segmentationId: string,
    toolGroupId?: string
  ): void {
    toolGroupId = toolGroupId ?? this._getFirstToolGroupId();

    const suppressEvents = false;
    this._setActiveSegmentationForToolGroup(
      segmentationId,
      toolGroupId,
      suppressEvents
    );
  }

  public setActiveSegmentForSegmentation(
    segmentationId: string,
    segmentIndex: number
  ): void {
    this._setActiveSegment(segmentationId, segmentIndex, false);
  }

  /**
   * Get all segmentations.
   *
   * @return Array of segmentations
   */
  public getSegmentations(): Segmentation[] {
    const segmentations = this.arrayOfObjects(this.segmentations);
    return (
      segmentations &&
      segmentations.map(m => this.segmentations[Object.keys(m)[0]])
    );
  }

  /**
   * Get specific segmentation by its id.
   *
   * @param segmentationId If of the segmentation
   * @return segmentation instance
   */
  public getSegmentation(segmentationId: string): Segmentation {
    return this.segmentations[segmentationId];
  }

  public addOrUpdateSegmentation(
    segmentationSchema: SegmentationSchema,
    suppressEvents = false,
    notYetUpdatedAtSource = false
  ): string {
    const { id: segmentationId } = segmentationSchema;
    let segmentation = this.segmentations[segmentationId];

    if (segmentation) {
      // Update the segmentation (mostly for assigning metadata/labels)
      Object.assign(segmentation, segmentationSchema);

      this._updateCornerstoneSegmentations({
        segmentationId,
        notYetUpdatedAtSource,
      });

      if (!suppressEvents) {
        this._broadcastEvent(this.EVENTS.SEGMENTATION_UPDATED, {
          segmentation,
        });
      }

      return segmentationId;
    }

    // Add the segmentation otherwise
    cstSegmentation.addSegmentations([
      {
        segmentationId,
        representation: {
          type: LABELMAP,
          // Todo: need to be generalized
          data: {
            volumeId: segmentationId,
          },
        },
      },
    ]);

    // Define a new color LUT and associate it with this segmentation.

    // Todo: need to be generalized to accept custom color LUTs
    const newColorLUT = this.generateNewColorLUT();
    const newColorLUTIndex = this.getNextColorLUTIndex();

    cstSegmentation.config.color.addColorLUT(newColorLUT, newColorLUTIndex);

    if (
      segmentationSchema.label === undefined ||
      segmentationSchema.label === ''
    ) {
      segmentationSchema.label = 'Segmentation';
    }

    this.segmentations[segmentationId] = {
      ...segmentationSchema,
      segments: [],
      activeSegmentIndex: segmentationSchema.activeSegmentIndex ?? null,
      segmentCount: 0,
      // Default to false, consumer should set it active using the API, may be adding lots of segmentations at once.
      isActive: false,
      colorLUTIndex: newColorLUTIndex,
      isVisible: true,
    };

    segmentation = this.segmentations[segmentationId];

    this._updateCornerstoneSegmentations({
      segmentationId,
      notYetUpdatedAtSource: true,
    });

    if (!suppressEvents) {
      this._broadcastEvent(this.EVENTS.SEGMENTATION_ADDED, {
        segmentation,
      });
    }

    return segmentationId;
  }

  public async createSegmentationForSEGDisplaySet(
    segDisplaySet,
    segmentationId?: string,
    suppressEvents = false
  ): Promise<string> {
    segmentationId = segmentationId ?? segDisplaySet.displaySetInstanceUID;
    const { segments, referencedVolumeId } = segDisplaySet;

    if (!segments || !referencedVolumeId) {
      throw new Error(
        'To create the segmentation from SEG displaySet, the displaySet should be loaded first, you can perform segDisplaySet.load() before calling this method.'
      );
    }

    const referencedVolume = cache.getVolume(referencedVolumeId);

    if (!referencedVolume) {
      throw new Error(
        `No volume found for referencedVolumeId: ${referencedVolumeId}`
      );
    }

    // Force use of a Uint8Array SharedArrayBuffer for the segmentation to save space and so
    // it is easily compressible in worker thread.
    const derivedVolume = await volumeLoader.createAndCacheDerivedVolume(
      referencedVolumeId,
      {
        volumeId: segmentationId,
        targetBuffer: {
          type: 'Uint8Array',
          sharedArrayBuffer: true,
        },
      }
    );
    const [rows, columns, numImages] = derivedVolume.dimensions;
    const derivedVolumeScalarData = derivedVolume.scalarData;

    // Note: ideally we could use the TypedArray set method, but since each
    // slice can have multiple segments, we need to loop over each slice and
    // set the segment value for each segment.

    for (const segmentIndex in segments) {
      const segmentInfo = segments[segmentIndex];
      const {
        numberOfFrames: segNumberOfFrame,
        pixelData: segPixelData,
      } = segmentInfo;

      const imageIdIndex = this._getSegmentImageIdIndex(
        segmentInfo,
        segmentIndex,
        referencedVolume
      );

      const step = rows * columns;

      // Note: this for loop is not optimized, since DICOM SEG stores
      // each segment as a separate labelmap so if there is a slice
      // that has multiple segments, we will have to loop over each
      // segment and we cannot use the TypedArray set method.
      for (let slice = 0; slice < numImages; slice++) {
        if (slice < imageIdIndex || slice >= imageIdIndex + segNumberOfFrame) {
          continue;
        }

        for (let i = 0; i < step; i++) {
          const derivedPixelIndex = i + slice * step;
          const segPixelIndex = i + (slice - imageIdIndex) * step;

          if (segPixelData[segPixelIndex] !== 0) {
            derivedVolumeScalarData[derivedPixelIndex] = Number(segmentIndex);
          }
        }
      }
    }

    const segmentationSchema = {
      id: segmentationId,
      volumeId: segmentationId,
      activeSegmentIndex: 1,
      cachedStats: {},
      label: '',
      segmentsLocked: new Set(),
      type: LABELMAP,
      displayText: [],
    };

    return this.addOrUpdateSegmentation(segmentationSchema, suppressEvents);
  }

  public createSegmentationForDisplaySet = async (
    displaySetInstanceUID: string,
    options?: { segmentationId: string; label: string }
  ): Promise<string> => {
    const volumeId = displaySetInstanceUID;

    const segmentationId = options?.segmentationId ?? `${csUtils.uuidv4()}`;

    // Force use of a Uint8Array SharedArrayBuffer for the segmentation to save space and so
    // it is easily compressible in worker thread.
    await volumeLoader.createAndCacheDerivedVolume(volumeId, {
      volumeId: segmentationId,
      targetBuffer: {
        type: 'Uint8Array',
        sharedArrayBuffer: true,
      },
    });

    const segmentationSchema: SegmentationSchema = {
      id: segmentationId,
      volumeId: segmentationId,
      activeSegmentIndex: 1,
      cachedStats: {},
      label: options?.label,
      segmentsLocked: new Set(),
      type: LABELMAP,
      displayText: [],
    };

    this.addOrUpdateSegmentation(segmentationSchema);

    return segmentationId;
  };

  /**
   * Toggles the visibility of a segmentation in the state, and broadcasts the event.
   * Note: this method does not update the segmentation state in the source. It only
   * updates the state, and there should be separate listeners for that.
   * @param ids segmentation ids
   */
  public toggleSegmentationVisibility = (segmentationId: string): void => {
    this._toggleSegmentationVisibility(segmentationId, false);
  };

  public addSegmentationRepresentationToToolGroup = async (
    toolGroupId: string,
    segmentationId: string,
    representationType = cstEnums.SegmentationRepresentations.Labelmap
  ): Promise<void> => {
    const segmentation = this.getSegmentation(segmentationId);

    if (!segmentation) {
      throw new Error(
        `Segmentation with segmentationId ${segmentationId} not found.`
      );
    }

    const { colorLUTIndex } = segmentation;

    // Based on the segmentationId, set the colorLUTIndex.
    const segmentationRepresentationUIDs = await cstSegmentation.addSegmentationRepresentations(
      toolGroupId,
      [
        {
          segmentationId,
          type: representationType,
        },
      ]
    );

    cstSegmentation.config.color.setColorLUT(
      toolGroupId,
      segmentationRepresentationUIDs[0],
      colorLUTIndex
    );
  };

  public removeSegmentationRepresentationFromToolGroup(
    toolGroupId: string,
    segmentationIds?: string[]
  ): void {
    segmentationIds =
      segmentationIds ??
      cstSegmentation.state
        .getSegmentationRepresentations(toolGroupId)
        .map(rep => rep.segmentationRepresentationUID);

    cstSegmentation.removeSegmentationsFromToolGroup(
      toolGroupId,
      segmentationIds
    );
  }

  /**
   * Removes a segmentation and broadcasts the removed event.
   *
   * @param {string} segmentationId The segmentation id
   */
  public remove(segmentationId: string): void {
    const segmentation = this.segmentations[segmentationId];
    const wasActive = segmentation.isActive;

    if (!segmentationId || !segmentation) {
      console.warn(
        `No segmentationId provided, or unable to find segmentation by id.`
      );
      return;
    }

    const { colorLUTIndex } = segmentation;

    this._removeSegmentationFromCornerstone(segmentationId);

    // Delete associated colormap
    // Todo: bring this back
    cstSegmentation.state.removeColorLUT(colorLUTIndex);

    delete this.segmentations[segmentationId];

    // If this segmentation was active, and there is another segmentation, set another one active.

    if (wasActive) {
      const remainingSegmentations = this.getSegmentations();

      if (remainingSegmentations.length) {
        const { id } = remainingSegmentations[0];

        this._setActiveSegmentationForToolGroup(
          id,
          this._getFirstToolGroupId(),
          false
        );
      }
    }

    this._broadcastEvent(this.EVENTS.SEGMENTATION_REMOVED, {
      segmentationId,
    });
  }

  public getConfiguration = (toolGroupId?: string): SegmentationConfig => {
    toolGroupId = toolGroupId ?? this._getFirstToolGroupId();

    const brushSize = cstUtils.segmentation.getBrushSizeForToolGroup(
      toolGroupId
    );

    const brushThresholdGate = cstUtils.segmentation.getBrushThresholdForToolGroup(
      toolGroupId
    );

    const config = cstSegmentation.config.getGlobalConfig();
    const { renderInactiveSegmentations } = config;

    const labelmapRepresentationConfig = config.representations.LABELMAP;

    const {
      renderOutline,
      outlineWidthActive,
      renderFill,
      fillAlpha,
      fillAlphaInactive,
    } = labelmapRepresentationConfig;

    return {
      brushSize,
      brushThresholdGate,
      fillAlpha,
      fillAlphaInactive,
      outlineWidthActive,
      renderFill,
      renderInactiveSegmentations,
      renderOutline,
    };
  };

  public setConfiguration = (configuration: SegmentationConfig): void => {
    const {
      brushSize,
      brushThresholdGate,
      fillAlpha,
      fillAlphaInactive,
      outlineWidthActive,
      renderFill,
      renderInactiveSegmentations,
      renderOutline,
    } = configuration;

    if (renderOutline !== undefined) {
      this._setLabelmapConfigValue('renderOutline', renderOutline);
    }

    if (outlineWidthActive !== undefined) {
      // Set for both active and inactive segmentations
      this._setLabelmapConfigValue('outlineWidthActive', outlineWidthActive);
      this._setLabelmapConfigValue('outlineWidthInactive', outlineWidthActive);
    }

    if (fillAlpha !== undefined) {
      this._setLabelmapConfigValue('fillAlpha', fillAlpha);
    }

    if (renderFill !== undefined) {
      this._setLabelmapConfigValue('renderFill', renderFill);
    }

    if (renderInactiveSegmentations !== undefined) {
      const config = cstSegmentation.config.getGlobalConfig();

      config.renderInactiveSegmentations = renderInactiveSegmentations;
      cstSegmentation.config.setGlobalConfig(config);
    }

    if (fillAlphaInactive !== undefined) {
      this._setLabelmapConfigValue('fillAlphaInactive', fillAlphaInactive);
    }

    if (brushSize !== undefined) {
      const { ToolGroupService } = this.servicesManager.services;

      const toolGroupIds = ToolGroupService.getToolGroupIds();

      toolGroupIds.forEach(toolGroupId => {
        cstUtils.segmentation.setBrushSizeForToolGroup(toolGroupId, brushSize);
      });
    }

    if (brushThresholdGate !== undefined) {
      const { ToolGroupService } = this.servicesManager.services;

      const toolGroupIds = ToolGroupService.getFirstToolGroupIds();

      toolGroupIds.forEach(toolGroupId => {
        cstUtils.segmentation.setBrushThresholdForToolGroup(
          toolGroupId,
          brushThresholdGate
        );
      });
    }

    this._broadcastEvent(
      this.EVENTS.SEGMENTATION_CONFIGURATION_CHANGED,
      this.getConfiguration()
    );
  };

  public getLabelmapVolume = (segmentationId: string) => {
    return cache.getVolume(segmentationId);
  };

  public getSegmentationRepresentationsForToolGroup = toolGroupId => {
    return cstSegmentation.state.getSegmentationRepresentations(toolGroupId);
  };

  private _setActiveSegmentationForToolGroup(
    segmentationId: string,
    toolGroupId: string,
    suppressEvents = false
  ) {
    const segmentations = this.getSegmentations();
    const targetSegmentation = this.getSegmentation(segmentationId);

    if (targetSegmentation === undefined) {
      throw new Error(`no segmentation for segmentationId: ${segmentationId}`);
    }

    // Todo: this has a bug in which others are not set to inactive,
    // commenting it for now
    // segmentations.forEach(segmentation => {
    //   segmentation.isActive = segmentation.id === segmentationId;
    // });

    const representation = this._getSegmentationRepresentation(
      segmentationId,
      toolGroupId
    );

    cstSegmentation.activeSegmentation.setActiveSegmentationRepresentation(
      toolGroupId,
      representation.segmentationRepresentationUID
    );

    if (suppressEvents === false) {
      this._broadcastEvent(this.EVENTS.SEGMENTATION_UPDATED, {
        segmentation: targetSegmentation,
      });
    }
  }

  private _toggleSegmentationVisibility = (
    segmentationId: string,
    suppressEvents = false
  ) => {
    const segmentation = this.segmentations[segmentationId];

    if (!segmentation) {
      throw new Error(
        `Segmentation with segmentationId ${segmentationId} not found.`
      );
    }

    segmentation.isVisible = !segmentation.isVisible;

    this._updateCornerstoneSegmentationVisibility(segmentationId);

    if (suppressEvents === false) {
      this._broadcastEvent(this.EVENTS.SEGMENTATION_UPDATED, {
        segmentation,
      });
    }
  };

  private _setActiveSegment(
    segmentationId: string,
    segmentIndex: number,
    suppressEvents = false
  ) {
    const segmentation = this.getSegmentation(segmentationId);

    if (segmentation === undefined) {
      throw new Error(`no segmentation for segmentationId: ${segmentationId}`);
    }

    cstSegmentation.segmentIndex.setActiveSegmentIndex(
      segmentationId,
      segmentIndex
    );

    segmentation.activeSegmentIndex = segmentIndex;

    if (suppressEvents === false) {
      this._broadcastEvent(this.EVENTS.SEGMENTATION_UPDATED, {
        segmentation,
      });
    }
  }

  private _setSegmentColor = (
    segmentationId: string,
    segmentIndex: number,
    color: Types.Point3,
    toolGroupId?: string,
    suppressEvents = false
  ) => {
    const segmentation = this.getSegmentation(segmentationId);

    if (segmentation === undefined) {
      throw new Error(`no segmentation for segmentationId: ${segmentationId}`);
    }

    const segmentInfo = segmentation.segments[segmentIndex];

    if (segmentInfo === undefined) {
      throw new Error(
        `Segment ${segmentIndex} not yet added to segmentation: ${segmentationId}`
      );
    }

    toolGroupId = toolGroupId ?? this._getFirstToolGroupId();

    const segmentationRepresentation = this._getSegmentationRepresentation(
      segmentationId,
      toolGroupId
    );

    if (!segmentationRepresentation) {
      throw new Error(
        'Must add representation to toolgroup before setting segments, currently'
      );
    }
    const { segmentationRepresentationUID } = segmentationRepresentation;

    const rgbaColor = cstSegmentation.config.color.getColorForSegmentIndex(
      toolGroupId,
      segmentationRepresentationUID,
      segmentIndex
    );

    cstSegmentation.config.color.setColorForSegmentIndex(
      toolGroupId,
      segmentationRepresentationUID,
      segmentIndex,
      [...color, rgbaColor[3]]
    );

    segmentInfo.color = color;

    if (suppressEvents === false) {
      this._broadcastEvent(this.EVENTS.SEGMENTATION_UPDATED, {
        segmentation,
      });
    }
  };

  private _setSegmentLocked(
    segmentationId: string,
    segmentIndex: number,
    isLocked: boolean,
    suppressEvents = false
  ) {
    const segmentation = this.getSegmentation(segmentationId);

    if (segmentation === undefined) {
      throw new Error(`no segmentation for segmentationId: ${segmentationId}`);
    }

    const segmentInfo = segmentation.segments[segmentIndex];

    if (segmentInfo === undefined) {
      throw new Error(
        `Segment ${segmentIndex} not yet added to segmentation: ${segmentationId}`
      );
    }

    segmentInfo.isLocked = isLocked;

    cstSegmentation.segmentLocking.setSegmentIndexLocked(
      segmentationId,
      segmentIndex,
      isLocked
    );

    if (suppressEvents === false) {
      this._broadcastEvent(this.EVENTS.SEGMENTATION_UPDATED, {
        segmentation,
      });
    }
  }

  private _setSegmentVisibility(
    segmentationId: string,
    segmentIndex: number,
    isVisible: boolean,
    toolGroupId?: string,
    suppressEvents = false
  ) {
    toolGroupId = toolGroupId ?? this._getFirstToolGroupId();

    const {
      segmentationRepresentationUID,
      segmentation,
    } = this._getSegmentationInfo(segmentationId, toolGroupId);

    if (segmentation === undefined) {
      throw new Error(`no segmentation for segmentationId: ${segmentationId}`);
    }

    const segmentInfo = segmentation.segments[segmentIndex];

    if (segmentInfo === undefined) {
      throw new Error(
        `Segment ${segmentIndex} not yet added to segmentation: ${segmentationId}`
      );
    }

    segmentInfo.isVisible = isVisible;

    cstSegmentation.config.visibility.setVisibilityForSegmentIndex(
      toolGroupId,
      segmentationRepresentationUID,
      segmentIndex,
      isVisible
    );

    if (suppressEvents === false) {
      this._broadcastEvent(this.EVENTS.SEGMENTATION_UPDATED, {
        segmentation,
      });
    }
  }

  private _setSegmentOpacity = (
    segmentationId: string,
    segmentIndex: number,
    opacity: number,
    toolGroupId?: string,
    suppressEvents = false
  ) => {
    const segmentation = this.getSegmentation(segmentationId);

    if (segmentation === undefined) {
      throw new Error(`no segmentation for segmentationId: ${segmentationId}`);
    }

    const segmentInfo = segmentation.segments[segmentIndex];

    if (segmentInfo === undefined) {
      throw new Error(
        `Segment ${segmentIndex} not yet added to segmentation: ${segmentationId}`
      );
    }

    toolGroupId = toolGroupId ?? this._getFirstToolGroupId();

    const segmentationRepresentation = this._getSegmentationRepresentation(
      segmentationId,
      toolGroupId
    );

    if (!segmentationRepresentation) {
      throw new Error(
        'Must add representation to toolgroup before setting segments, currently'
      );
    }
    const { segmentationRepresentationUID } = segmentationRepresentation;

    const rgbaColor = cstSegmentation.config.color.getColorForSegmentIndex(
      toolGroupId,
      segmentationRepresentationUID,
      segmentIndex
    );

    cstSegmentation.config.color.setColorForSegmentIndex(
      toolGroupId,
      segmentationRepresentationUID,
      segmentIndex,
      [rgbaColor[0], rgbaColor[1], rgbaColor[2], opacity]
    );

    segmentInfo.opacity = opacity;

    if (suppressEvents === false) {
      this._broadcastEvent(this.EVENTS.SEGMENTATION_UPDATED, {
        segmentation,
      });
    }
  };

  private _setSegmentLabel(
    segmentationId: string,
    segmentIndex: number,
    segmentLabel: string,
    suppressEvents = false
  ) {
    const segmentation = this.getSegmentation(segmentationId);

    if (segmentation === undefined) {
      throw new Error(`no segmentation for segmentationId: ${segmentationId}`);
    }

    const segmentInfo = segmentation.segments[segmentIndex];

    if (segmentInfo === undefined) {
      throw new Error(
        `Segment ${segmentIndex} not yet added to segmentation: ${segmentationId}`
      );
    }

    segmentInfo.label = segmentLabel;

    if (suppressEvents === false) {
      this._broadcastEvent(this.EVENTS.SEGMENTATION_UPDATED, {
        segmentation,
      });
    }
  }

  private _getSegmentationRepresentation(segmentationId, toolGroupId) {
    const segmentationRepresentations = this.getSegmentationRepresentationsForToolGroup(
      toolGroupId
    );

    if (segmentationRepresentations.length === 0) {
      return;
    }

    // Todo: this finds the first segmentation representation that matches the segmentationId
    // If there are two labelmap representations from the same segmentation, this will not work
    const representation = segmentationRepresentations.find(
      representation => representation.segmentationId === segmentationId
    );

    return representation;
  }

  private _setLabelmapConfigValue = (property, value) => {
    const config = cstSegmentation.config.getGlobalConfig();

    config.representations.LABELMAP[property] = value;
    cstSegmentation.config.setGlobalConfig(config);

    const { CornerstoneViewportService } = this.servicesManager.services;

    const renderingEngine = CornerstoneViewportService.getRenderingEngine();
    const viewportIds = CornerstoneViewportService.getViewportIds();

    renderingEngine.renderViewports(viewportIds);
  };

  private _initSegmentationService() {
    // Connect Segmentation Service to Cornerstone3D.
    eventTarget.addEventListener(
      csToolsEnums.Events.SEGMENTATION_MODIFIED,
      this._onSegmentationModified
    );

    eventTarget.addEventListener(
      csToolsEnums.Events.SEGMENTATION_DATA_MODIFIED,
      this._onSegmentationDataModified
    );
  }

  private _onSegmentationDataModified = evt => {
    const { segmentationId } = evt.detail;

    const segmentation = this.getSegmentation(segmentationId);

    if (segmentation === undefined) {
      // Part of add operation, not update operation, exit early.
      return;
    }

    this._broadcastEvent(this.EVENTS.SEGMENTATION_DATA_MODIFIED, {
      segmentation,
    });
  };

  private _onSegmentationModified = evt => {
    const { segmentationId } = evt.detail;

    const segmentation = this.segmentations[segmentationId];

    if (segmentation === undefined) {
      // Part of add operation, not update operation, exit early.
      return;
    }

    const segmentationState = cstSegmentation.state.getSegmentation(
      segmentationId
    );

    if (!segmentationState) {
      return;
    }

    if (!Object.keys(segmentationState.representationData).includes(LABELMAP)) {
      throw new Error('Non-labelmap representations are not supported yet');
    }

    const {
      activeSegmentIndex,
      cachedStats,
      segmentsLocked,
      representationData,
      label,
      type,
    } = segmentationState;

    const labelmapRepresentationData = representationData[LABELMAP];

    // TODO: handle other representations when available in cornerstone3D
    const segmentationSchema = {
      activeSegmentIndex,
      cachedStats,
      displayText: [],
      id: segmentationId,
      label,
      segmentsLocked,
      type,
      volumeId: labelmapRepresentationData.volumeId,
    };

    try {
      this.addOrUpdateSegmentation(segmentationSchema);
    } catch (error) {
      console.warn(
        `Failed to add/update segmentation ${segmentationId}`,
        error
      );
    }
  };

  private _getSegmentationInfo(segmentationId: string, toolGroupId: string) {
    const segmentation = this.getSegmentation(segmentationId);

    if (segmentation === undefined) {
      throw new Error(`no segmentation for segmentationId: ${segmentationId}`);
    }
    const segmentationRepresentation = this._getSegmentationRepresentation(
      segmentationId,
      toolGroupId
    );

    if (!segmentationRepresentation) {
      throw new Error(
        'Must add representation to toolgroup before setting segments, currently'
      );
    }

    const { segmentationRepresentationUID } = segmentationRepresentation;

    return { segmentationRepresentationUID, segmentation };
  }

  private _removeSegmentationFromCornerstone(segmentationId: string) {
    // TODO: This should be from the configuration
    const removeFromCache = true;
    const segmentationState = cstSegmentation.state;
    const sourceSegState = segmentationState.getSegmentation(segmentationId);

    if (!sourceSegState) {
      return;
    }

    const toolGroupIds = segmentationState.getToolGroupsWithSegmentation(
      segmentationId
    );

    toolGroupIds.forEach(toolGroupId => {
      const segmentationRepresentations = segmentationState.getSegmentationRepresentations(
        toolGroupId
      );

      const UIDsToRemove = [];
      segmentationRepresentations.forEach(representation => {
        if (representation.segmentationId === segmentationId) {
          UIDsToRemove.push(representation.segmentationRepresentationUID);
        }
      });

      // remove segmentation representations
      cstSegmentation.removeSegmentationsFromToolGroup(
        toolGroupId,
        UIDsToRemove
      );
    });

    // cleanup the segmentation state too
    segmentationState.removeSegmentation(segmentationId);

    if (removeFromCache) {
      cache.removeVolumeLoadObject(segmentationId);
    }
  }

  private _updateCornerstoneSegmentations({
    segmentationId,
    notYetUpdatedAtSource,
  }) {
    if (notYetUpdatedAtSource === false) {
      return;
    }
    const segmentationState = cstSegmentation.state;
    const sourceSegmentation = segmentationState.getSegmentation(
      segmentationId
    );
    const segmentation = this.segmentations[segmentationId];
    const { label } = segmentation;

    // Update the label in the source if necessary
    if (sourceSegmentation.label !== label) {
      sourceSegmentation.label = label;
    }
  }

  private _updateCornerstoneSegmentationVisibility = segmentationId => {
    const segmentationState = cstSegmentation.state;
    const toolGroupIds = segmentationState.getToolGroupsWithSegmentation(
      segmentationId
    );

    toolGroupIds.forEach(toolGroupId => {
      const segmentationRepresentations = cstSegmentation.state.getSegmentationRepresentations(
        toolGroupId
      );

      if (segmentationRepresentations.length === 0) {
        return;
      }

      // Todo: this finds the first segmentation representation that matches the segmentationId
      // If there are two labelmap representations from the same segmentation, this will not work
      const representation = segmentationRepresentations.find(
        representation => representation.segmentationId === segmentationId
      );

      const visibility = cstSegmentation.config.visibility.getSegmentationVisibility(
        toolGroupId,
        representation.segmentationRepresentationUID
      );

      cstSegmentation.config.visibility.setSegmentationVisibility(
        toolGroupId,
        representation.segmentationRepresentationUID,
        !visibility
      );
    });
  };

  private _getFirstToolGroupId = () => {
    const { ToolGroupService } = this.servicesManager.services;
    const toolGroupIds = ToolGroupService.getToolGroupIds();

    return toolGroupIds[0];
  };

  private getNextColorLUTIndex = (): number => {
    let i = 0;
    while (true) {
      if (cstSegmentation.state.getColorLUT(i) === undefined) {
        return i;
      }

      i++;
    }
  };

  private generateNewColorLUT() {
    const newColorLUT = cloneDeep(COLOR_LUT);

    return newColorLUT;
  }

  /**
   * Converts object of objects to array.
   *
   * @return {Array} Array of objects
   */
  private arrayOfObjects = obj => {
    return Object.entries(obj).map(e => ({ [e[0]]: e[1] }));
  };

  private _getSegmentImageIdIndex = (
    segmentInfo,
    segmentIndex,
    referencedVolume
  ) => {
    const referencedImageOrigin = referencedVolume.origin;
    const referencedVolumeSliceSpacing = referencedVolume.spacing[2];

    const segmentImagePositionPatient = segmentInfo.firstImagePositionPatient;

    // find the closest slice in the referenced volume to the segment's first image position
    // this is the slice where the segment will be inserted in the scalarData
    const estimatedSliceNumber =
      Math.sqrt(
        Math.pow(segmentImagePositionPatient[0] - referencedImageOrigin[0], 2) +
          Math.pow(
            segmentImagePositionPatient[1] - referencedImageOrigin[1],
            2
          ) +
          Math.pow(segmentImagePositionPatient[2] - referencedImageOrigin[2], 2)
      ) / referencedVolumeSliceSpacing;

    if (
      Math.abs(Math.round(estimatedSliceNumber) - estimatedSliceNumber) >
      EPSILON
    ) {
      throw new Error(
        `Segment ${segmentIndex} has an invalid image position: ${segmentImagePositionPatient} which starts
        from the middle of the slice of the referenced volume.`
      );
    }

    return Math.round(estimatedSliceNumber);
  };
}

export default SegmentationService;
export { EVENTS, VALUE_TYPES };
